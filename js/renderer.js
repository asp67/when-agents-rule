// Helper: draw sword + shield icon for infantry units
function drawSwordAndShieldIcon(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;

    // Shield (left side)
    ctx.fillStyle = '#4488cc';
    ctx.strokeStyle = '#225588';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx - 8, cy + 2, 10, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Shield cross
    ctx.strokeStyle = '#aaccff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 8);
    ctx.lineTo(cx - 8, cy + 12);
    ctx.moveTo(cx - 16, cy + 2);
    ctx.lineTo(cx, cy + 2);
    ctx.stroke();

    // Sword (right side, angled)
    ctx.save();
    ctx.translate(cx + 6, cy);
    ctx.rotate(-0.3);
    // Blade
    ctx.fillStyle = '#cccccc';
    ctx.strokeStyle = '#888888';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(3, -14);
    ctx.lineTo(2.5, 4);
    ctx.lineTo(-2.5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Guard
    ctx.fillStyle = '#aa8833';
    ctx.fillRect(-5, 4, 10, 3);
    // Handle
    ctx.fillStyle = '#664422';
    ctx.fillRect(-1.5, 7, 3, 7);
    ctx.restore();
}

// Helper: draw bow icon for ranged units
function drawBowIcon(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;

    // Bow (curved arc)
    ctx.strokeStyle = '#8B4513';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx - 2, cy, 16, -Math.PI / 2.5, Math.PI / 2.5);
    ctx.stroke();

    // Bowstring
    ctx.strokeStyle = '#dddddd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const topX = cx - 2 + 16 * Math.cos(-Math.PI / 2.5);
    const topY = cy - 16 * Math.sin(-Math.PI / 2.5);
    const botX = cx - 2 + 16 * Math.cos(Math.PI / 2.5);
    const botY = cy + 16 * Math.sin(Math.PI / 2.5);
    ctx.moveTo(topX, topY);
    ctx.lineTo(botX, botY);
    ctx.stroke();

    // Arrow nocked
    ctx.strokeStyle = '#666666';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy);
    ctx.lineTo(topX, topY);
    ctx.stroke();

    // Arrowhead
    ctx.fillStyle = '#aaaaaa';
    ctx.beginPath();
    ctx.moveTo(topX + 4, topY);
    ctx.lineTo(topX, topY - 3);
    ctx.lineTo(topX, topY + 3);
    ctx.closePath();
    ctx.fill();
}

// Helper: draw pike/lance icon for cavalry units
function drawPikeIcon(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;

    // Pike shaft
    ctx.strokeStyle = '#8B6914';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, -16);
    ctx.lineTo(cx, 16);
    ctx.stroke();

    // Pike head (triangular spear tip)
    ctx.fillStyle = '#bbbbbb';
    ctx.strokeStyle = '#888888';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, -18);
    ctx.lineTo(cx + 5, -8);
    ctx.lineTo(cx - 5, -8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Small pennant/flag near tip
    ctx.fillStyle = '#cc3333';
    ctx.beginPath();
    ctx.moveTo(cx + 1, -14);
    ctx.lineTo(cx + 10, -11);
    ctx.lineTo(cx + 1, -8);
    ctx.closePath();
    ctx.fill();
}

// Three.js renderer for the 3D game
class GameRenderer {
    constructor(container) {
        this.container = container;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.units = [];
        this.buildings = [];
        this._marqueeEl = null;   // screen-space drag-select rectangle (DOM overlay)
        this.selectionStart = null;
        this.isSelecting = false;
        this.selectedUnits = [];
        this.selectedBuilding = null;
        this.cameraPosition = { x: 0, y: 80, z: 80 };
        this.cameraTarget = new THREE.Vector3(0, 0, 0);
        this.minZoom = 32;   // closest distance from the look-at target
        this.maxZoom = 620;  // furthest (whole battlefield)
        this.cameraPanSpeed = 0.8; // Speed of camera panning
        this.keysPressed = {}; // Track which keys are currently pressed
        this.isDragging = false;
        this.isMiddleDragging = false;
        this.isRightDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.dragThreshold = 5;
        this.hasDragged = false;
        this.terrain = null;
        this.buildingPreview = null;
        this.buildingPreviewMaterial = null;
        this.isPlacingBuilding = false;
        this.placingBuildingType = null;
        this.clock = new THREE.Clock();
        this.init();
    }

    init() {
        // Create scene
        this.scene = new THREE.Scene();
        // Warm hazy horizon fog (matches the sky dome's lower band)
        // Only the far horizon/water hazes; the battlefield stays clear at any zoom.
        this.scene.fog = new THREE.Fog(0xdfe9f0, 950, 2800);

        // Create camera (45-degree angle)
        // Use fallback dimensions if container is 0x0 (e.g., hidden by display:none)
        const containerWidth = this.container.clientWidth || window.innerWidth;
        const containerHeight = this.container.clientHeight || window.innerHeight;
        const aspect = containerWidth / containerHeight;
        this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
        this.camera.position.set(this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z);
        this.camera.lookAt(this.cameraTarget);

        // Create renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(containerWidth, containerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // Vibrant, predictable colour pipeline for stylised low-poly.
        // (ACES tone mapping crushes saturated greens, so we skip it.)
        if (THREE.sRGBEncoding !== undefined) this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.container.appendChild(this.renderer.domElement);

        // Gradient sky dome + matching fog
        this.createSkyDome();

        // --- Lighting: warm key + cool sky fill ---
        const ambientLight = new THREE.AmbientLight(0xfff0d8, 0.3);
        this.scene.add(ambientLight);

        const hemiLight = new THREE.HemisphereLight(0xcfe2ff, 0x7d9a5c, 0.45);
        hemiLight.position.set(0, 200, 0);
        this.scene.add(hemiLight);

        const directionalLight = new THREE.DirectionalLight(0xffe9c2, 0.95);
        directionalLight.position.set(120, 180, 80);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        directionalLight.shadow.camera.near = 0.5;
        directionalLight.shadow.camera.far = 700;
        // normalBias fixes shadow acne on the large flat ground (which was darkening
        // the whole shadow frustum); keep a tiny depth bias as well.
        directionalLight.shadow.bias = -0.00008;
        directionalLight.shadow.normalBias = 2.2;
        // Shadow frustum follows the camera target (set each frame) for crisp shadows
        const sb = 180;
        directionalLight.shadow.camera.left = -sb;
        directionalLight.shadow.camera.right = sb;
        directionalLight.shadow.camera.top = sb;
        directionalLight.shadow.camera.bottom = -sb;
        this.scene.add(directionalLight);
        this.scene.add(directionalLight.target);
        this.sunLight = directionalLight;

        // Subtle cool fill from the opposite side (no shadows) to lift shadows
        const fillLight = new THREE.DirectionalLight(0x9db8e0, 0.18);
        fillLight.position.set(-100, 90, -120);
        this.scene.add(fillLight);

        // Handle window resize
        window.addEventListener('resize', () => this.onWindowResize());

        // Camera rotation with middle mouse button
        this.renderer.domElement.addEventListener('mousedown', (e) => this.onCanvasMouseDown(e));
        this.renderer.domElement.addEventListener('mousemove', (e) => this.onCanvasMouseMove(e));
        this.renderer.domElement.addEventListener('mouseup', (e) => this.onCanvasMouseUp(e));
        this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
        this.renderer.domElement.addEventListener('wheel', (e) => this.onCanvasWheel(e), { passive: false });
        
        // Keyboard controls for camera panning
        document.addEventListener('keydown', (e) => this.onKeyDown(e));
        document.addEventListener('keyup', (e) => this.onKeyUp(e));

        // Start render loop
        this.animate();
    }

    setTerrain(terrain) {
        this.terrain = terrain;
    }

    // Large inverted sphere with a vertical gradient: deep blue zenith -> warm haze horizon
    createSkyDome() {
        const skyGeo = new THREE.SphereGeometry(900, 32, 16);
        const skyMat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            depthWrite: false,
            fog: false,
            uniforms: {
                topColor: { value: new THREE.Color(0x2e5a93) },
                midColor: { value: new THREE.Color(0x8fb4dd) },
                bottomColor: { value: new THREE.Color(0xe9ddc6) }
            },
            vertexShader: `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 wp = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = wp.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying vec3 vWorldPosition;
                uniform vec3 topColor;
                uniform vec3 midColor;
                uniform vec3 bottomColor;
                void main() {
                    float h = normalize(vWorldPosition).y;
                    vec3 col;
                    if (h > 0.15) {
                        col = mix(midColor, topColor, clamp((h - 0.15) / 0.85, 0.0, 1.0));
                    } else {
                        col = mix(bottomColor, midColor, clamp((h + 0.1) / 0.25, 0.0, 1.0));
                    }
                    gl_FragColor = vec4(col, 1.0);
                }
            `
        });
        this.skyDome = new THREE.Mesh(skyGeo, skyMat);
        this.scene.add(this.skyDome);

        // Sun glow: a soft radial sprite fixed in the sun-light's direction (child
        // of the dome, so it follows the camera like the sky itself).
        const sunCanvas = document.createElement('canvas');
        sunCanvas.width = sunCanvas.height = 128;
        const sctx = sunCanvas.getContext('2d');
        const grad = sctx.createRadialGradient(64, 64, 6, 64, 64, 64);
        grad.addColorStop(0, 'rgba(255, 246, 220, 1)');
        grad.addColorStop(0.25, 'rgba(255, 236, 190, 0.85)');
        grad.addColorStop(0.6, 'rgba(255, 226, 170, 0.25)');
        grad.addColorStop(1, 'rgba(255, 226, 170, 0)');
        sctx.fillStyle = grad;
        sctx.fillRect(0, 0, 128, 128);
        const sun = new THREE.Sprite(new THREE.SpriteMaterial({
            map: new THREE.CanvasTexture(sunCanvas), depthWrite: false, depthTest: true, fog: false
        }));
        const sunDir = new THREE.Vector3(120, 180, 80).normalize();
        sun.position.copy(sunDir.multiplyScalar(820));
        sun.scale.set(260, 260, 1);
        this.skyDome.add(sun);

        // A few slow-drifting billboard clouds on a rotating child layer (the dome
        // gradient is Y-rotation-invariant, but the SUN must not drift — so only
        // this layer spins, see animate()).
        const cloudCanvas = document.createElement('canvas');
        cloudCanvas.width = 256; cloudCanvas.height = 128;
        const cctx = cloudCanvas.getContext('2d');
        const puff = (x, y, r) => {
            const g = cctx.createRadialGradient(x, y, r * 0.15, x, y, r);
            g.addColorStop(0, 'rgba(255,255,255,0.9)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            cctx.fillStyle = g;
            cctx.fillRect(x - r, y - r, r * 2, r * 2);
        };
        puff(70, 72, 52); puff(120, 58, 62); puff(175, 74, 50); puff(135, 84, 44);
        const cloudTex = new THREE.CanvasTexture(cloudCanvas);
        this.cloudLayer = new THREE.Group();
        for (let i = 0; i < 7; i++) {
            const c = new THREE.Sprite(new THREE.SpriteMaterial({
                map: cloudTex, depthWrite: false, depthTest: true, fog: false,
                opacity: 0.4 + (i % 3) * 0.12
            }));
            const az = (i / 7) * Math.PI * 2 + (i * 1.7) % 1;   // spread around the sky
            const el = 0.28 + ((i * 0.37) % 0.3);               // upper hemisphere band
            const r = 700 + (i % 3) * 60;
            c.position.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r);
            const w = 220 + (i % 4) * 70;
            c.scale.set(w, w * 0.45, 1);
            this.cloudLayer.add(c);
        }
        this.skyDome.add(this.cloudLayer);
    }

    addUnit(unit) {
        this.units.push(unit);
        this.createUnitMesh(unit);
    }

    // Free a removed object's GPU resources. Meshes here are Groups of sub-meshes,
    // each with its own geometry/material — without disposal they accumulate in
    // GPU memory forever (very noticeable across several back-to-back arenas).
    disposeObject(obj) {
        if (!obj || typeof obj.traverse !== 'function') return;
        obj.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => {
                    if (m.map) m.map.dispose();
                    m.dispose();
                });
            }
        });
    }

    removeUnit(unit) {
        const idx = this.units.indexOf(unit);
        if (idx > -1) {
            this.units.splice(idx, 1);
            if (unit.mesh) {
                this.scene.remove(unit.mesh);
                this.disposeObject(unit.mesh);
            }
            if (unit.healthBar) {
                this.scene.remove(unit.healthBar);
                this.disposeObject(unit.healthBar);
            }
        }
    }

    addBuilding(building) {
        this.buildings.push(building);
        this.createBuildingMesh(building);
    }

    removeBuilding(building) {
        const idx = this.buildings.indexOf(building);
        if (idx > -1) {
            this.buildings.splice(idx, 1);
            if (building.mesh) {
                this.scene.remove(building.mesh);
                this.disposeObject(building.mesh);
            }
            if (building.healthBar) {
                this.scene.remove(building.healthBar);
                this.disposeObject(building.healthBar);
            }
        }
    }

    // ------------------------------------------------------------------
    // Combat & death effects (purely cosmetic — pooled, no per-frame allocs)
    // ------------------------------------------------------------------

    // Arced projectile from attacker to victim (arrows for ranged units, a stone
    // ball for towers). Pooled; excess requests during huge battles are dropped.
    spawnProjectile(from, to, kind) {
        if (!this._projectiles) this._projectiles = [];
        let p = this._projectiles.find(q => !q.active);
        if (!p) {
            if (this._projectiles.length >= 64) return;
            const geo = new THREE.CylinderGeometry(0.06, 0.06, 1.2, 4);
            geo.rotateX(Math.PI / 2); // shaft along +Z so lookAt() aims it
            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x7a5230 }));
            mesh.visible = false;
            this.scene.add(mesh);
            p = { mesh, active: false };
            this._projectiles.push(p);
        }
        p.active = true;
        p.t = 0;
        const dist = Math.hypot(to.x - from.x, to.z - from.z);
        p.dur = Math.max(0.16, dist / 42); // ~42 world units/s flight speed
        p.sx = from.x; p.sy = from.y; p.sz = from.z;
        p.tx = to.x; p.ty = to.y; p.tz = to.z;
        p.arc = kind === 'stone' ? 2.0 : 3.0;
        p.mesh.material.color.setHex(kind === 'stone' ? 0x9aa3ad : 0x7a5230);
        p.mesh.scale.setScalar(kind === 'stone' ? 0.7 : 1);
        p.mesh.visible = true;
    }

    // Brief red emissive flash on a struck entity (restores each material's own
    // previous emissive, so selection highlights survive).
    flashHit(entity) {
        const mesh = entity && entity.mesh;
        if (!mesh) return;
        if (!this._flashing) this._flashing = new Set();
        if (!mesh._flashMats) {
            mesh._flashMats = [];
            mesh.traverse(c => { if (c.material && c.material.emissive) mesh._flashMats.push(c.material); });
        }
        if (!mesh._flashUntil) { // don't re-snapshot mid-flash
            mesh._flashMats.forEach(m => { m._preFlash = m.emissive.getHex(); m.emissive.setHex(0xff2818); });
        }
        mesh._flashUntil = Date.now() + 130;
        this._flashing.add(mesh);
    }

    // Death: tip over, sink and fade instead of vanishing. Detaches the entity
    // from tracking immediately (game logic is already done with it) and animates
    // a ghost of the mesh, then disposes it.
    killUnit(unit) {
        const idx = this.units.indexOf(unit);
        if (idx > -1) this.units.splice(idx, 1);
        if (unit.healthBar) { this.scene.remove(unit.healthBar); this.disposeObject(unit.healthBar); unit.healthBar = null; }
        const mesh = unit.mesh;
        unit.mesh = null;
        if (!mesh) return;
        this._startDeath(mesh, 'unit', 0.9);
        this.spawnDust(unit.x, 0.5, unit.z, 10, 0x9a8f7a);
    }

    // Destruction: crumple (y-scale down), sink and fade, with a dust burst.
    killBuilding(building) {
        const idx = this.buildings.indexOf(building);
        if (idx > -1) this.buildings.splice(idx, 1);
        if (building.healthBar) { this.scene.remove(building.healthBar); this.disposeObject(building.healthBar); building.healthBar = null; }
        const mesh = building.mesh;
        building.mesh = null;
        if (!mesh) return;
        this._startDeath(mesh, 'building', 1.25);
        this.spawnDust(building.x, 1.4, building.z, 24, 0xb0a48e);
    }

    _startDeath(mesh, kind, dur) {
        if (!this._dying) this._dying = [];
        const mats = [];
        mesh.traverse(c => {
            if (c.material) { c.material.transparent = true; mats.push(c.material); }
        });
        this._flashing && this._flashing.delete(mesh);
        this._dying.push({ mesh, mats, kind, dur, t: 0, baseY: mesh.position.y });
    }

    // Pooled dust burst (THREE.Points) for deaths/collapses.
    spawnDust(x, y, z, count, color) {
        if (!this._dustPool) this._dustPool = [];
        let d = this._dustPool.find(q => !q.active);
        if (!d) {
            if (this._dustPool.length >= 16) return;
            const N = 24;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
            const mat = new THREE.PointsMaterial({ size: 0.9, transparent: true, opacity: 0.8, depthWrite: false });
            const pts = new THREE.Points(geo, mat);
            pts.visible = false;
            pts.frustumCulled = false;
            this.scene.add(pts);
            d = { pts, vels: new Float32Array(N * 3), N, active: false };
            this._dustPool.push(d);
        }
        d.active = true;
        d.t = 0;
        d.dur = 0.8;
        d.pts.material.color.setHex(color || 0xb0a48e);
        const pos = d.pts.geometry.attributes.position.array;
        const n = Math.min(d.N, count || d.N);
        for (let i = 0; i < d.N; i++) {
            const j = i * 3;
            if (i < n) {
                pos[j] = x; pos[j + 1] = y; pos[j + 2] = z;
                const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 3;
                d.vels[j] = Math.cos(a) * r;
                d.vels[j + 1] = 2.2 + Math.random() * 2.6;
                d.vels[j + 2] = Math.sin(a) * r;
            } else {
                pos[j + 1] = -50; // park unused points below the world
                d.vels[j] = d.vels[j + 1] = d.vels[j + 2] = 0;
            }
        }
        d.pts.geometry.attributes.position.needsUpdate = true;
        d.pts.material.opacity = 0.8;
        d.pts.visible = true;
    }

    // Expanding ground ring marking a fresh battle (throttled by game.notifyCombat).
    spawnBattleRing(x, z) {
        if (!this._rings) this._rings = [];
        let r = this._rings.find(q => !q.active);
        if (!r) {
            if (this._rings.length >= 8) return;
            const mesh = new THREE.Mesh(
                new THREE.RingGeometry(0.85, 1.0, 40),
                new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide })
            );
            mesh.rotation.x = -Math.PI / 2;
            mesh.renderOrder = 3; // above the fog plane so pings show through it
            mesh.visible = false;
            this.scene.add(mesh);
            r = { mesh, active: false };
            this._rings.push(r);
        }
        r.active = true;
        r.t = 0;
        r.dur = 0.9;
        r.mesh.position.set(x, 0.7, z);
        r.mesh.visible = true;
    }

    // Advance all pooled effects (called once per rendered frame).
    updateEffects(dt, time) {
        // Projectiles: lerp along the shot with a small arc.
        if (this._projectiles) for (const p of this._projectiles) {
            if (!p.active) continue;
            p.t += dt / p.dur;
            if (p.t >= 1) { p.active = false; p.mesh.visible = false; continue; }
            const k = p.t;
            const x = p.sx + (p.tx - p.sx) * k;
            const z = p.sz + (p.tz - p.sz) * k;
            const y = p.sy + (p.ty - p.sy) * k + Math.sin(Math.PI * k) * p.arc;
            const prev = p.mesh.position;
            p.mesh.lookAt(x, y, z); // aim along the flight path before moving
            prev.set(x, y, z);
        }

        // Hit flashes: restore materials when the flash window ends.
        if (this._flashing && this._flashing.size) {
            const now = Date.now();
            for (const mesh of this._flashing) {
                if (now >= mesh._flashUntil) {
                    mesh._flashMats.forEach(m => { if (m._preFlash !== undefined) m.emissive.setHex(m._preFlash); });
                    mesh._flashUntil = 0;
                    this._flashing.delete(mesh);
                }
            }
        }

        // Deaths: units tip over and sink; buildings crumple. Both fade out.
        if (this._dying) for (let i = this._dying.length - 1; i >= 0; i--) {
            const d = this._dying[i];
            d.t += dt;
            const k = Math.min(1, d.t / d.dur);
            if (d.kind === 'unit') {
                d.mesh.rotation.z = k * (Math.PI / 2) * 0.9;
                d.mesh.position.y = d.baseY - 0.5 * k;
            } else {
                d.mesh.scale.y = Math.max(0.08, 1 - 0.92 * k);
                d.mesh.position.y = d.baseY - 0.8 * k;
            }
            const op = 1 - k;
            d.mats.forEach(m => { m.opacity = op; });
            if (k >= 1) {
                this.scene.remove(d.mesh);
                this.disposeObject(d.mesh);
                this._dying.splice(i, 1);
            }
        }

        // Dust bursts: scatter, rise, settle, fade.
        if (this._dustPool) for (const d of this._dustPool) {
            if (!d.active) continue;
            d.t += dt;
            const k = d.t / d.dur;
            if (k >= 1) { d.active = false; d.pts.visible = false; continue; }
            const pos = d.pts.geometry.attributes.position.array;
            for (let i = 0; i < d.N; i++) {
                const j = i * 3;
                pos[j] += d.vels[j] * dt;
                pos[j + 1] += d.vels[j + 1] * dt;
                pos[j + 2] += d.vels[j + 2] * dt;
                d.vels[j + 1] -= 7 * dt; // gravity
            }
            d.pts.geometry.attributes.position.needsUpdate = true;
            d.pts.material.opacity = 0.8 * (1 - k);
        }

        // Battle rings: expand and fade.
        if (this._rings) for (const r of this._rings) {
            if (!r.active) continue;
            r.t += dt;
            const k = r.t / r.dur;
            if (k >= 1) { r.active = false; r.mesh.visible = false; continue; }
            const s = 1 + k * 9;
            r.mesh.scale.set(s, s, 1);
            r.mesh.material.opacity = 0.7 * (1 - k);
        }
    }

    createUnitMesh(unit) {
        const group = new THREE.Group();
        const bodyMaterial = new THREE.MeshLambertMaterial({ color: unit.color });
        const darkMaterial = new THREE.MeshLambertMaterial({ color: 0x333333 });
        const skinMaterial = new THREE.MeshLambertMaterial({ color: 0xd4a574 });

        // Unit body - different shapes per type
        if (unit.unitType === 'cavalry') {
            // --- Low-poly horse + rider -------------------------------------
            const horseMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f }); // chestnut
            const maneMat  = new THREE.MeshLambertMaterial({ color: 0x2b1d10 }); // mane/tail
            const teamMat  = new THREE.MeshLambertMaterial({ color: unit.color }); // caparison + rider
            const metalMat = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
            const woodMat  = new THREE.MeshLambertMaterial({ color: 0x7a5230 });

            // Barrel of the body, rounded at chest and haunch
            const barrelGeo = new THREE.CylinderGeometry(0.34, 0.34, 1.3, 10);
            barrelGeo.rotateZ(Math.PI / 2);
            const barrel = new THREE.Mesh(barrelGeo, horseMat);
            barrel.position.set(0, 0.92, 0); barrel.castShadow = true; group.add(barrel);
            const chest = new THREE.Mesh(new THREE.SphereGeometry(0.36, 10, 8), horseMat);
            chest.position.set(0.58, 0.92, 0); chest.castShadow = true; group.add(chest);
            const haunch = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), horseMat);
            haunch.position.set(-0.58, 0.95, 0); haunch.castShadow = true; group.add(haunch);

            // Arched neck
            const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.28, 0.7, 8), horseMat);
            neck.position.set(0.8, 1.25, 0); neck.rotation.z = -Math.PI / 4; neck.castShadow = true; group.add(neck);

            // Head + muzzle + ears
            const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.24), horseMat);
            head.position.set(1.08, 1.5, 0); head.rotation.z = -0.28; head.castShadow = true; group.add(head);
            const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.17, 0.2), horseMat);
            muzzle.position.set(1.27, 1.4, 0); muzzle.rotation.z = -0.28; group.add(muzzle);
            [-0.08, 0.08].forEach(dz => {
                const ear = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.15, 5), horseMat);
                ear.position.set(0.98, 1.67, dz); group.add(ear);
            });

            // Mane crest along the neck
            const mane = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.07), maneMat);
            mane.position.set(0.84, 1.43, 0); mane.rotation.z = -Math.PI / 4; group.add(mane);

            // Legs: upper leg + dark hoof, in a slight gallop-ready stance
            const legPositions = [
                { x: 0.52, z: 0.2 }, { x: 0.52, z: -0.2 },
                { x: -0.52, z: 0.2 }, { x: -0.52, z: -0.2 }
            ];
            legPositions.forEach(pos => {
                const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.72, 6), horseMat);
                leg.position.set(pos.x, 0.4, pos.z); leg.castShadow = true; group.add(leg);
                const hoof = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 6), darkMaterial);
                hoof.position.set(pos.x, 0.06, pos.z); group.add(hoof);
            });

            // Flowing tail
            const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.13, 0.62, 6), maneMat);
            tail.position.set(-1.0, 0.74, 0); tail.rotation.z = Math.PI / 3; tail.castShadow = true; group.add(tail);

            // Team-coloured saddle blanket (keeps team identity readable at a glance)
            const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.12, 0.64), teamMat);
            cloth.position.set(-0.02, 1.12, 0); cloth.castShadow = true; group.add(cloth);

            // Rider torso, head, helmet
            const riderBody = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 0.55, 8), teamMat);
            riderBody.position.set(-0.04, 1.5, 0); riderBody.castShadow = true; group.add(riderBody);
            const riderHead = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), skinMaterial);
            riderHead.position.set(-0.04, 1.86, 0); riderHead.castShadow = true; group.add(riderHead);
            const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), metalMat);
            helmet.position.set(-0.04, 1.9, 0); helmet.castShadow = true; group.add(helmet);

            // Couched lance (makes cavalry instantly recognisable)
            const lance = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.9, 5), woodMat);
            lance.position.set(0.22, 1.42, 0.24); lance.castShadow = true; group.add(lance);
            const lanceTip = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.26, 6), metalMat);
            lanceTip.position.set(0.22, 2.4, 0.24); group.add(lanceTip);

        } else {
            // Non-cavalry: standard humanoid body. Torsos taper toward the
            // shoulders (top radius < bottom) for a less tin-can silhouette.
            let bodyGeometry;

            switch(unit.unitType) {
                case 'worker':
                    bodyGeometry = new THREE.CylinderGeometry(0.3, 0.42, 1, 8);
                    break;
                case 'infantry':
                    bodyGeometry = new THREE.CylinderGeometry(0.4, 0.52, 1.2, 8);
                    break;
                case 'ranged':
                    bodyGeometry = new THREE.CylinderGeometry(0.3, 0.42, 1.1, 8);
                    break;
                case 'support':
                    bodyGeometry = new THREE.CylinderGeometry(0.32, 0.42, 1.1, 8);
                    break;
                default:
                    bodyGeometry = new THREE.CylinderGeometry(0.4, 0.5, 1, 8);
            }

            const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
            body.position.y = 0.5;
            body.castShadow = true;
            group.add(body);

            // Head for non-cavalry units
            const headGeo = new THREE.SphereGeometry(0.25, 6, 6);
            const head = new THREE.Mesh(headGeo, skinMaterial);
            let headY;
            switch(unit.unitType) {
                case 'worker': headY = 1.15; break;
                case 'infantry': headY = 1.4; break;
                case 'ranged': headY = 1.3; break;
                case 'support': headY = 1.3; break;
                default: headY = 1.1;
            }
            head.position.set(0, headY, 0);
            head.castShadow = true;
            group.add(head);

            // Simple arms: two angled sleeves from the shoulders. Cheap, but they
            // break up the cylinder silhouette and "hold" the equipment visually.
            const shoulderY = headY - 0.32;
            const armGeo = new THREE.CylinderGeometry(0.07, 0.06, 0.55, 5);
            const armL = new THREE.Mesh(armGeo, bodyMaterial);
            armL.position.set(-0.32, shoulderY - 0.18, 0);
            armL.rotation.z = 0.5; armL.castShadow = true; group.add(armL);
            const armR = new THREE.Mesh(armGeo, bodyMaterial);
            armR.position.set(0.32, shoulderY - 0.18, 0);
            armR.rotation.z = -0.5; armR.castShadow = true; group.add(armR);

            // --- Equipment, each assembled as ONE sub-group so parts share a local
            // frame and can never drift apart (the old worker axe positioned its
            // head as a sibling of a ROTATED handle — it floated in mid-air). ---
            const metalMat = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
            const woodMat = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
            if (unit.unitType === 'infantry') {
                const helm = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), metalMat);
                helm.position.set(0, headY + 0.04, 0); helm.castShadow = true; group.add(helm);
                const spear = new THREE.Group();
                const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.8, 5), woodMat);
                shaft.castShadow = true; spear.add(shaft);
                const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 6), metalMat);
                tip.position.set(0, 1.0, 0); spear.add(tip); // seated on the shaft top (local frame)
                spear.position.set(0.45, 0.9, 0);
                group.add(spear);
                const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 12), new THREE.MeshLambertMaterial({ color: 0x6b4a2a }));
                shield.rotation.z = Math.PI / 2; shield.position.set(-0.45, 0.7, 0); shield.castShadow = true; group.add(shield);
            } else if (unit.unitType === 'ranged') {
                const bow = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 6, 14, Math.PI * 1.15), woodMat);
                bow.rotation.y = Math.PI / 2; bow.position.set(0.42, 0.85, 0); bow.castShadow = true; group.add(bow);
                const quiver = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 6), new THREE.MeshLambertMaterial({ color: 0x6b4a2a }));
                quiver.position.set(-0.28, 1.0, -0.22); quiver.rotation.x = 0.35; quiver.castShadow = true; group.add(quiver);
            } else if (unit.unitType === 'support') {
                const staff = new THREE.Group();
                const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.7, 5), woodMat);
                pole.castShadow = true; staff.add(pole);
                const orb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), new THREE.MeshLambertMaterial({ color: 0xffe08a }));
                orb.position.set(0, 0.92, 0); staff.add(orb); // riding the pole top (local frame)
                staff.position.set(0.38, 0.95, 0);
                group.add(staff);
            } else if (unit.unitType === 'worker') {
                // Axe as one rigid sub-group: head welded to the top of the handle
                // in LOCAL coordinates, then the whole tool is posed once.
                const axe = new THREE.Group();
                const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.95, 5), woodMat);
                handle.castShadow = true; axe.add(handle);
                const toolHead = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.1), metalMat);
                toolHead.position.set(0.1, 0.42, 0); // hugs the handle top, blade forward
                toolHead.castShadow = true; axe.add(toolHead);
                axe.position.set(0.42, 0.72, 0);
                axe.rotation.z = -0.25; // resting on the shoulder-side, head up & out
                group.add(axe);
            }
        }

        // Health bar background (Sprite always faces camera, no z-fighting)
        const healthBgCanvas = document.createElement('canvas');
        healthBgCanvas.width = 64; healthBgCanvas.height = 8;
        const healthBgCtx = healthBgCanvas.getContext('2d');
        healthBgCtx.fillStyle = '#333333';
        healthBgCtx.fillRect(0, 0, 64, 8);
        const healthBgTexture = new THREE.CanvasTexture(healthBgCanvas);
        const healthBgMat = new THREE.SpriteMaterial({ map: healthBgTexture, depthTest: false, depthWrite: false });
        const healthBg = new THREE.Sprite(healthBgMat);
        healthBg.scale.set(1.2, 0.15, 1);
        healthBg.position.set(0, 1.5, 0); // Center above unit
        group.add(healthBg);

        // Health bar (Sprite always faces camera, no z-fighting)
        const healthCanvas = document.createElement('canvas');
        healthCanvas.width = 64; healthCanvas.height = 8;
        const healthCtx = healthCanvas.getContext('2d');
        healthCtx.fillStyle = '#00ff00';
        healthCtx.fillRect(0, 0, 64, 8);
        const healthTexture = new THREE.CanvasTexture(healthCanvas);
        const healthMat = new THREE.SpriteMaterial({ map: healthTexture, depthTest: false, depthWrite: false });
        const healthBar = new THREE.Sprite(healthMat);
        healthBar.scale.set(1.1, 0.1, 1);
        healthBar.position.set(0, 1.5, 0); // Center above unit
        group.add(healthBar);

        // Cavalry are taller (horse + rider + lance): lift the bar clear of them.
        if (unit.unitType === 'cavalry') {
            healthBg.position.y = 2.2;
            healthBar.position.y = 2.2;
        }

        unit.healthBar = healthBar;
        unit.healthBarBg = healthBg;
        unit.healthBarCanvas = healthCanvas;
        unit.healthBarCtx = healthCtx;
        unit.healthBarTexture = healthTexture;

        // Unit identification icons above head (always visible sprites)
        let iconY;
        if (unit.unitType === 'cavalry') {
            iconY = 2.4;
        } else {
            iconY = 2.0;
        }

        // Floating sword/bow/pike icons removed — units now carry real 3D equipment,
        // which keeps the battlefield much less cluttered.

        // Priest: golden halo (3D ring above head)
        if (unit.unitType === 'support') {
            const haloGeo = new THREE.TorusGeometry(0.4, 0.05, 8, 24);
            const haloMat = new THREE.MeshBasicMaterial({ color: 0xffdd00, transparent: true, opacity: 0.9 });
            const halo = new THREE.Mesh(haloGeo, haloMat);
            halo.position.set(0, iconY, 0);
            halo.rotation.x = Math.PI / 2; // Flat, facing up
            group.add(halo);
            unit.halo = halo;
        }

        // Resource icon (only for workers, hidden by default)
        if (unit.type === 'worker') {
            const iconCanvas = document.createElement('canvas');
            iconCanvas.width = 64; iconCanvas.height = 64;
            const iconCtx = iconCanvas.getContext('2d');
            const iconTexture = new THREE.CanvasTexture(iconCanvas);
            const iconMat = new THREE.SpriteMaterial({ map: iconTexture, depthTest: false, depthWrite: false, transparent: true });
            const iconSprite = new THREE.Sprite(iconMat);
            iconSprite.scale.set(2.5, 2.5, 1);
            iconSprite.position.set(0, 2.2, 0); // Above health bar
            iconSprite.visible = false;
            group.add(iconSprite);
            
            unit.resourceIcon = iconSprite;
            unit.resourceIconCtx = iconCtx;
            unit.resourceIconTexture = iconTexture;
        }

        unit.mesh = group;
        unit.body = group.children[0]; // Reference first child as body
        unit.baseY = 0; // Base Y position for animations

        this.updateUnitPosition(unit);
        this.scene.add(group);
    }

    // A scaffolded construction site: foundation + a translucent shell that rises
    // with build progress (animated in updateBuildingVisuals) + scaffolding.
    buildConstructionSite(building, group, civColor) {
        const foot = building.isWonder ? 9 : 5;
        const foundation = new THREE.Mesh(
            new THREE.BoxGeometry(foot, 0.4, foot),
            new THREE.MeshLambertMaterial({ color: 0x6b5536 }));
        foundation.position.y = 0.2; foundation.receiveShadow = true; group.add(foundation);

        const shellH = building.isWonder ? 8 : 4;
        const shellMat = new THREE.MeshLambertMaterial({ color: civColor, transparent: true, opacity: 0.6 });
        const shellGeo = new THREE.BoxGeometry(foot * 0.78, shellH, foot * 0.78);
        shellGeo.translate(0, shellH / 2, 0); // pivot at base so it grows upward
        const shell = new THREE.Mesh(shellGeo, shellMat);
        shell.position.y = 0.4; shell.scale.y = 0.06; shell.castShadow = true;
        group.add(shell);
        building.buildShell = shell;
        building.buildShellMat = shellMat;

        const poleMat = new THREE.MeshLambertMaterial({ color: 0x9a7b4f });
        const half = foot * 0.5;
        const poleH = shellH + 0.6;
        [[half, half], [half, -half], [-half, half], [-half, -half]].forEach(([px, pz]) => {
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, poleH, 5), poleMat);
            pole.position.set(px, poleH / 2, pz); pole.castShadow = true; group.add(pole);
        });
        const railX = new THREE.BoxGeometry(foot + 0.3, 0.12, 0.12);
        const railZ = new THREE.BoxGeometry(0.12, 0.12, foot + 0.3);
        [poleH - 0.3, poleH * 0.5].forEach(ry => {
            const a = new THREE.Mesh(railX, poleMat); a.position.set(0, ry, half); group.add(a);
            const b = new THREE.Mesh(railX, poleMat); b.position.set(0, ry, -half); group.add(b);
            const c = new THREE.Mesh(railZ, poleMat); c.position.set(half, ry, 0); group.add(c);
            const d = new THREE.Mesh(railZ, poleMat); d.position.set(-half, ry, 0); group.add(d);
        });
    }

    // Grand, distinct mesh per civ Wonder, plus a pulsing ground glow.
    buildWonderMesh(building, group, civColor) {
        const stone = new THREE.MeshLambertMaterial({ color: 0xdabb7a });
        const accent = new THREE.MeshLambertMaterial({ color: civColor });
        const t = building.type;
        if (t === 'pyramid') {
            for (let i = 0; i < 6; i++) {
                const s = 10 - i * 1.6;
                const step = new THREE.Mesh(new THREE.BoxGeometry(s, 1.4, s), stone);
                step.position.y = 0.7 + i * 1.4; step.castShadow = true; step.receiveShadow = true; group.add(step);
            }
            const cap = new THREE.Mesh(new THREE.ConeGeometry(1.2, 1.6, 4), accent);
            cap.position.y = 0.7 + 6 * 1.4 + 0.2; cap.rotation.y = Math.PI / 4; group.add(cap);
        } else if (t === 'akropolis') {
            const base = new THREE.Mesh(new THREE.BoxGeometry(11, 1.2, 8), stone); base.position.y = 0.6; base.receiveShadow = true; group.add(base);
            const colGeo = new THREE.CylinderGeometry(0.5, 0.55, 5, 10);
            for (let cx = -4.5; cx <= 4.5; cx += 1.8) {
                [3, -3].forEach(cz => { const col = new THREE.Mesh(colGeo, stone); col.position.set(cx, 3.7, cz); col.castShadow = true; group.add(col); });
            }
            const roof = new THREE.Mesh(new THREE.BoxGeometry(11.5, 1, 8.5), accent); roof.position.y = 6.7; roof.castShadow = true; group.add(roof);
            const ped = new THREE.Mesh(new THREE.BoxGeometry(12, 0.4, 9), stone); ped.position.y = 7.4; group.add(ped);
        } else if (t === 'firetemple') {
            const base = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 3, 8), stone); base.position.y = 1.5; base.castShadow = true; group.add(base);
            const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.2, 5, 8), stone); tower.position.y = 5.5; tower.castShadow = true; group.add(tower);
            const bowl = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 1.6, 1, 8), accent); bowl.position.y = 8.3; group.add(bowl);
            const fire = new THREE.Mesh(new THREE.ConeGeometry(1.8, 3, 8), new THREE.MeshBasicMaterial({ color: 0xff7a1a })); fire.position.y = 10; group.add(fire);
        } else { // shrine (torii gate)
            const base = new THREE.Mesh(new THREE.BoxGeometry(9, 1, 9), stone); base.position.y = 0.5; base.receiveShadow = true; group.add(base);
            const pillarGeo = new THREE.CylinderGeometry(0.5, 0.6, 7, 8);
            const pillarMat = new THREE.MeshLambertMaterial({ color: 0xc0392b });
            [-3, 3].forEach(px => { const p = new THREE.Mesh(pillarGeo, pillarMat); p.position.set(px, 4, 0); p.castShadow = true; group.add(p); });
            const top1 = new THREE.Mesh(new THREE.BoxGeometry(9, 0.8, 1.4), pillarMat); top1.position.set(0, 7.6, 0); top1.castShadow = true; group.add(top1);
            const top2 = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.5, 1), new THREE.MeshLambertMaterial({ color: 0x2c3e50 })); top2.position.set(0, 6.7, 0); group.add(top2);
        }
        const glow = new THREE.Mesh(
            new THREE.RingGeometry(6.5, 7.8, 40),
            new THREE.MeshBasicMaterial({ color: civColor, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
        glow.rotation.x = -Math.PI / 2; glow.position.y = 0.15; group.add(glow);
        building.wonderGlow = glow;
    }

    // ---- shared building props ----
    _battlements(group, mat, w, d, topY, block) {
        block = block || 0.5;
        const hw = w / 2, hd = d / 2;
        const geo = new THREE.BoxGeometry(block, block * 1.1, block);
        const place = (x, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, topY + block * 0.55, z); m.castShadow = true; group.add(m); };
        for (let x = -hw; x <= hw + 0.001; x += block * 2) { place(x, -hd); place(x, hd); }
        for (let z = -hd + block * 2; z <= hd - block * 2 + 0.001; z += block * 2) { place(-hw, z); place(hw, z); }
    }
    _flag(group, civColor, x, y, z, h) {
        h = h || 2;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, h, 5), new THREE.MeshLambertMaterial({ color: 0x5c4326 }));
        pole.position.set(x, y + h / 2, z); pole.castShadow = true; group.add(pole);
        const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.08), new THREE.MeshLambertMaterial({ color: civColor }));
        cloth.position.set(x + 0.5, y + h - 0.45, z); cloth.castShadow = true; group.add(cloth);
    }

    buildTownCenter(group, civ, age) {
        age = age || 'stone';
        const civMat = new THREE.MeshLambertMaterial({ color: civ });
        const stone = new THREE.MeshLambertMaterial({ color: 0x9b958a });
        const stoneDark = new THREE.MeshLambertMaterial({ color: 0x837e76 });
        const hide = new THREE.MeshLambertMaterial({ color: 0xb08d5a });
        const thatch = new THREE.MeshLambertMaterial({ color: 0xc2a45c });
        const wood = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
        const woodDark = new THREE.MeshLambertMaterial({ color: 0x523619 });
        const dark = new THREE.MeshLambertMaterial({ color: 0x33240f });

        if (age === 'stone') {
            // Big Tippy: an oversized teepee with poles and a banner.
            const tent = new THREE.Mesh(new THREE.ConeGeometry(3.4, 6.2, 10), hide); tent.position.y = 3.1; tent.castShadow = true; group.add(tent);
            for (let i = 0; i < 5; i++) { const a = i * (Math.PI * 2 / 5) + 0.3; const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.8, 4), wood); pole.position.set(Math.cos(a) * 0.4, 6.1, Math.sin(a) * 0.4); pole.rotation.set(Math.sin(a) * 0.32, 0, -Math.cos(a) * 0.32); group.add(pole); }
            // painted band around the base + door flap
            const band = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.9, 0.6, 10, 1, true), civMat); band.position.y = 1.1; group.add(band);
            const flap = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.0, 0.12), dark); flap.position.set(0, 1.0, 3.0); group.add(flap);
            this._flag(group, civ, 0, 6.4, 0, 2.0);
        } else if (age === 'neolithic') {
            // Large community hut: a broad round wall under a big thatch dome.
            const wall = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.6, 2.4, 16), new THREE.MeshLambertMaterial({ color: 0x8a6f49 })); wall.position.y = 1.2; wall.castShadow = true; group.add(wall);
            const dome = new THREE.Mesh(new THREE.SphereGeometry(3.7, 16, 9, 0, Math.PI * 2, 0, Math.PI / 2), thatch); dome.position.y = 2.4; dome.castShadow = true; group.add(dome);
            const cap = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.0, 8), woodDark); cap.position.y = 6.0; group.add(cap);
            // eave tufts + civ band + door
            for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.9, 4), thatch); tuft.position.set(Math.cos(a) * 3.5, 2.5, Math.sin(a) * 3.5); tuft.rotation.x = Math.PI; group.add(tuft); }
            const band = new THREE.Mesh(new THREE.CylinderGeometry(3.45, 3.45, 0.5, 16, 1, true), civMat); band.position.y = 0.5; group.add(band);
            const door = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.0, 0.2), dark); door.position.set(0, 1.0, 3.55); group.add(door);
            this._flag(group, civ, 0, 6.0, 0, 1.8);
        } else if (age === 'bronze') {
            // Longhouse: a long timber hall with a pitched thatch roof (kept compact).
            const body = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 4.2), wood); body.position.y = 1.5; body.castShadow = true; group.add(body);
            // corner + ridge posts
            [[-3.8, -1.9], [3.8, -1.9], [-3.8, 1.9], [3.8, 1.9], [0, -1.9], [0, 1.9]].forEach(([x, z]) => { const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.1, 0.3), woodDark); p.position.set(x, 1.5, z); group.add(p); });
            // gable roof: two long slopes
            const r1 = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.3, 3.0), thatch); r1.position.set(0, 3.9, -1.1); r1.rotation.x = -0.5; r1.castShadow = true; group.add(r1);
            const r2 = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.3, 3.0), thatch); r2.position.set(0, 3.9, 1.1); r2.rotation.x = 0.5; r2.castShadow = true; group.add(r2);
            const ridge = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.25, 0.25), woodDark); ridge.position.set(0, 4.55, 0); group.add(ridge);
            const door = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.0, 0.2), dark); door.position.set(0, 1.0, 2.15); group.add(door);
            this._flag(group, civ, -3.8, 3.0, 0, 1.8);
        } else {
            // Iron: a small castle — stone keep with corner turrets and battlements.
            const base = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, 7), stone); base.position.y = 1.7; base.castShadow = true; base.receiveShadow = true; group.add(base);
            this._battlements(group, stoneDark, 7, 7, 3.4, 0.5);
            // four corner turrets
            [[-3.4, -3.4], [3.4, -3.4], [-3.4, 3.4], [3.4, 3.4]].forEach(([x, z]) => {
                const t = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 5, 9), stone); t.position.set(x, 2.5, z); t.castShadow = true; group.add(t);
                const cone = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.3, 9), civMat); cone.position.set(x, 5.65, z); cone.castShadow = true; group.add(cone);
            });
            // central keep + gatehouse door
            const keep = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.2, 3.4), stoneDark); keep.position.y = 4.7; keep.castShadow = true; group.add(keep);
            const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.2, 0.2), dark); door.position.set(0, 1.1, 3.55); group.add(door);
            this._flag(group, civ, 0, 5.9, 0, 2.0);
        }
    }

    buildBarracks(group, civ) {
        const civMat = new THREE.MeshLambertMaterial({ color: civ });
        const body = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3, 4.6), civMat); body.position.y = 1.5; body.castShadow = true; group.add(body);
        this._battlements(group, civMat, 5.2, 4.6, 3, 0.5); // flat fort top, no roof
        const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2, 0.2), new THREE.MeshLambertMaterial({ color: 0x2b1d0e })); door.position.set(0, 1, 2.35); group.add(door);
        // shield + crossed swords emblem (infantry)
        const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.12, 14), new THREE.MeshLambertMaterial({ color: 0xc9a23a }));
        shield.rotation.x = Math.PI / 2; shield.position.set(0, 2.25, 2.42); group.add(shield);
        const metal = new THREE.MeshLambertMaterial({ color: 0xcfd6dd });
        [-1, 1].forEach(s => { const sw = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 5), metal); sw.position.set(0, 2.25, 2.5); sw.rotation.z = s * Math.PI / 4; group.add(sw); });
        // weapon rack beside the door: two spears leaning into an X on a low rail
        // (one rigid sub-group, welded-parts pattern)
        const rack = new THREE.Group();
        const rackWood = new THREE.MeshLambertMaterial({ color: 0x6b4a2a });
        const rail = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.1, 0.1), rackWood); rail.position.y = 0.95; rack.add(rail);
        [-1, 1].forEach(s => {
            const spear = new THREE.Group();
            const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.9, 5), rackWood); shaft.castShadow = true; spear.add(shaft);
            const tip = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 6), metal); tip.position.y = 1.05; spear.add(tip);
            spear.position.set(s * 0.28, 0.95, 0);
            spear.rotation.z = s * 0.3;
            rack.add(spear);
        });
        rack.position.set(-1.9, 0, 2.5);
        group.add(rack);
    }

    buildStable(group, civ) {
        const civMat = new THREE.MeshLambertMaterial({ color: civ });
        const wood = new THREE.MeshLambertMaterial({ color: 0x6b4a2a });
        const body = new THREE.Mesh(new THREE.BoxGeometry(6, 2.4, 4), civMat); body.position.y = 1.2; body.castShadow = true; group.add(body);
        // gable (barn) roof: two slopes meeting at a ridge
        const r1 = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.25, 2.7), wood); r1.position.set(0, 3.05, -1.0); r1.rotation.x = -0.5; r1.castShadow = true; group.add(r1);
        const r2 = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.25, 2.7), wood); r2.position.set(0, 3.05, 1.0); r2.rotation.x = 0.5; r2.castShadow = true; group.add(r2);
        // two open stall arches on the front
        const dark = new THREE.MeshLambertMaterial({ color: 0x2b1d0e });
        [-1.4, 1.4].forEach(x => { const a = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.6, 0.2), dark); a.position.set(x, 0.8, 2.05); group.add(a); });
        // corral fence + hay bale beside the barn
        const fenceMat = new THREE.MeshLambertMaterial({ color: 0x8a6334 });
        for (let x = 3.4; x <= 6.4; x += 1.0) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1, 5), fenceMat); p.position.set(x, 0.5, 2.4); group.add(p); }
        const rail = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.1, 0.1), fenceMat); rail.position.set(4.9, 0.7, 2.4); group.add(rail);
        const hay = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.9, 10), new THREE.MeshLambertMaterial({ color: 0xd8b65a })); hay.rotation.z = Math.PI / 2; hay.position.set(4.6, 0.5, 1.2); hay.castShadow = true; group.add(hay);
        // water trough inside the corral (dark wood box with a still-water surface)
        const trough = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.4, 0.6), new THREE.MeshLambertMaterial({ color: 0x4a3320 })); trough.position.set(5.2, 0.2, 1.5); trough.castShadow = true; group.add(trough);
        const tWater = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.06, 0.44), new THREE.MeshLambertMaterial({ color: 0x3a5a7a })); tWater.position.set(5.2, 0.38, 1.5); group.add(tWater);
    }

    buildArcheryRange(group, civ) {
        const civMat = new THREE.MeshLambertMaterial({ color: civ });
        const wood = new THREE.MeshLambertMaterial({ color: 0x6b4a2a });
        const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.2, 4), civMat); body.position.y = 1.1; body.castShadow = true; group.add(body);
        // single-slope lean-to roof
        const roof = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.25, 4.8), wood); roof.position.set(0, 2.7, 0); roof.rotation.x = 0.32; roof.castShadow = true; group.add(roof);
        // unmistakable target on a post
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.8, 6), wood); post.position.set(3.2, 1.4, 0); post.castShadow = true; group.add(post);
        const ring = (r, c, zo) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.12, 18), new THREE.MeshLambertMaterial({ color: c })); m.rotation.x = Math.PI / 2; m.position.set(3.2, 2.7, zo); group.add(m); };
        ring(0.9, 0xf5f5f5, 0.0); ring(0.6, 0xe94560, 0.06); ring(0.3, 0xffd45e, 0.12);
    }

    buildHouse(group, civ, age) {
        age = age || 'stone';
        const civMat = new THREE.MeshLambertMaterial({ color: civ });
        const hide = new THREE.MeshLambertMaterial({ color: 0xb08d5a });
        const thatch = new THREE.MeshLambertMaterial({ color: 0xc2a45c });
        const shag = new THREE.MeshLambertMaterial({ color: 0x9c8048 });
        const wood = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
        const wallStone = new THREE.MeshLambertMaterial({ color: 0xa6a097 });
        const dark = new THREE.MeshLambertMaterial({ color: 0x2b1d0e });

        if (age === 'stone') {
            // Tippy (teepee): a hide cone with poles poking out the top.
            const tent = new THREE.Mesh(new THREE.ConeGeometry(1.9, 3.4, 9), hide); tent.position.y = 1.7; tent.castShadow = true; group.add(tent);
            for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 4), wood); pole.position.set(Math.cos(a) * 0.25, 3.4, Math.sin(a) * 0.25); pole.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3); group.add(pole); }
            const flap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.1), dark); flap.position.set(0, 0.6, 1.7); group.add(flap);
        } else if (age === 'neolithic') {
            // Shag hut: a low round wall under a shaggy thatch dome.
            const wallC = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.8, 1.3, 12), new THREE.MeshLambertMaterial({ color: 0x8a6f49 })); wallC.position.y = 0.65; wallC.castShadow = true; group.add(wallC);
            const dome = new THREE.Mesh(new THREE.SphereGeometry(1.9, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2), shag); dome.position.y = 1.3; dome.castShadow = true; group.add(dome);
            // shaggy thatch tufts around the eaves
            for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 4), shag); tuft.position.set(Math.cos(a) * 1.75, 1.35, Math.sin(a) * 1.75); tuft.rotation.x = Math.PI; group.add(tuft); }
            const door = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.15), dark); door.position.set(0, 0.5, 1.78); group.add(door);
        } else if (age === 'bronze') {
            // Wooden hut: timber walls with a pitched thatch roof.
            const bodyB = new THREE.Mesh(new THREE.BoxGeometry(3, 1.9, 3), wood); bodyB.position.y = 0.95; bodyB.castShadow = true; group.add(bodyB);
            // corner posts to read as timber framing
            [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]].forEach(([x, z]) => { const p = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.0, 0.22), new THREE.MeshLambertMaterial({ color: 0x5c3d22 })); p.position.set(x, 0.95, z); group.add(p); });
            const roof = new THREE.Mesh(new THREE.ConeGeometry(2.5, 1.7, 4), thatch); roof.position.y = 2.8; roof.rotation.y = Math.PI / 4; roof.castShadow = true; group.add(roof);
            const door = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.15), dark); door.position.set(0, 0.6, 1.55); group.add(door);
        } else {
            // Iron: stone masonry house with a tiled roof and chimney.
            const bodyS = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 3), wallStone); bodyS.position.y = 1; bodyS.castShadow = true; group.add(bodyS);
            // stone-block hint along the base
            const plinth = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, 3.2), new THREE.MeshLambertMaterial({ color: 0x8d877d })); plinth.position.y = 0.25; group.add(plinth);
            const roof = new THREE.Mesh(new THREE.ConeGeometry(2.5, 1.7, 4), new THREE.MeshLambertMaterial({ color: 0x7a4a3a })); roof.position.y = 2.85; roof.rotation.y = Math.PI / 4; roof.castShadow = true; group.add(roof);
            const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.3, 0.5), new THREE.MeshLambertMaterial({ color: 0x6f6960 })); chimney.position.set(0.85, 2.9, 0.85); chimney.castShadow = true; group.add(chimney);
            const chimCap = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.4, 6), new THREE.MeshLambertMaterial({ color: 0x8d877d })); chimCap.position.set(0.85, 3.75, 0.85); group.add(chimCap); // seated on the chimney top (3.55)
            const door = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.15), dark); door.position.set(0, 0.6, 1.55); group.add(door);
        }
        // Small civ-coloured banner so the owner stays identifiable at every age.
        this._flag(group, civ, 1.5, 0, 1.5, 1.6);
    }

    buildFarm(group, age) {
        age = age || 'stone';
        const soil = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.25, 4.4), new THREE.MeshLambertMaterial({ color: 0x6b4f2e })); soil.position.y = 0.12; soil.receiveShadow = true; group.add(soil);
        const cropMat = new THREE.MeshLambertMaterial({ color: 0x86b34a });

        if (age === 'stone') {
            // Dirt patch: bare turned soil with a few clods, no crops yet.
            const clodMat = new THREE.MeshLambertMaterial({ color: 0x5a4226 });
            const clods = [[-1.2, -0.8, 0.5], [0.9, 1.1, 0.6], [0.2, -1.3, 0.45], [-0.6, 0.9, 0.4], [1.4, -0.4, 0.5]];
            clods.forEach(([x, z, r]) => { const c = new THREE.Mesh(new THREE.BoxGeometry(r, 0.18, r), clodMat); c.position.set(x, 0.28, z); group.add(c); });
        } else if (age === 'neolithic') {
            // Unorganized patchy field: irregular tufts of crops scattered about.
            const spots = [[-1.5, -1.3], [-0.8, 1.0], [0.3, -0.6], [1.3, 0.7], [-1.2, 0.4], [0.9, -1.4], [1.5, -0.2], [-0.2, 1.5], [0.6, 0.2]];
            spots.forEach(([x, z], i) => {
                const h = 0.35 + (i % 3) * 0.18;
                const tuft = new THREE.Mesh(new THREE.BoxGeometry(0.5, h, 0.5), cropMat);
                tuft.position.set(x, 0.12 + h / 2, z); tuft.rotation.y = i * 0.7; group.add(tuft);
            });
        } else {
            // Bronze (and Iron — no further upgrade): a proper field of neat rows.
            for (let z = -1.5; z <= 1.5; z += 0.75) { const row = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.3, 0.3), cropMat); row.position.set(0, 0.33, z); group.add(row); }
        }
    }

    buildTemple(group, civ) {
        const sand = new THREE.MeshLambertMaterial({ color: 0xe9ddc0 });
        const civMat = new THREE.MeshLambertMaterial({ color: civ });
        const base = new THREE.Mesh(new THREE.BoxGeometry(5, 1, 5), sand); base.position.y = 0.5; base.receiveShadow = true; group.add(base);
        const inner = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 3.4), civMat); inner.position.y = 2.3; inner.castShadow = true; group.add(inner);
        [[-2.1, -2.1], [2.1, -2.1], [-2.1, 2.1], [2.1, 2.1]].forEach(([x, z]) => { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 3, 10), sand); c.position.set(x, 2.5, z); c.castShadow = true; group.add(c); });
        const entab = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 5), sand); entab.position.y = 4.2; group.add(entab);
        const dome = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xdaa520 })); dome.position.y = 4.4; dome.castShadow = true; group.add(dome);
        const fin = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), new THREE.MeshLambertMaterial({ color: 0xffe08a })); fin.position.y = 6.3; group.add(fin);
        // twin braziers flanking the entrance, with softly glowing flames
        [-1.9, 1.9].forEach(x => {
            const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.45, 8), new THREE.MeshLambertMaterial({ color: 0x5a4226 }));
            bowl.position.set(x, 0.22, 3.0); bowl.castShadow = true; group.add(bowl);
            const flame = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 6), new THREE.MeshLambertMaterial({ color: 0xffa03c, emissive: 0xb34a00 }));
            flame.position.set(x, 0.72, 3.0); group.add(flame);
        });
    }

    buildMarket(group, civ) {
        const civMat = new THREE.MeshLambertMaterial({ color: civ });
        const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2, 4.4), civMat); body.position.y = 1; body.castShadow = true; group.add(body);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.3, 4.9), new THREE.MeshLambertMaterial({ color: 0x6b4a2a })); roof.position.y = 2.15; group.add(roof);
        // bright striped awnings out front (the market signature)
        const awn = (color, x) => { const a = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.16, 1.7), new THREE.MeshLambertMaterial({ color })); a.position.set(x, 1.75, 2.7); a.rotation.x = 0.38; a.castShadow = true; group.add(a); };
        awn(0xe94560, -1.5); awn(0xf2f2f2, 0); awn(0x4ecca3, 1.5);
        // crates + barrel
        const crate = new THREE.MeshLambertMaterial({ color: 0x9c6b3b });
        const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), crate); c1.position.set(-1.6, 0.35, 3.0); c1.castShadow = true; group.add(c1);
        const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), crate); c2.position.set(-0.92, 0.28, 3.1); group.add(c2); // clear of c1's corner
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.8, 10), new THREE.MeshLambertMaterial({ color: 0x7a5230 })); barrel.position.set(1.7, 0.4, 3.0); barrel.castShadow = true; group.add(barrel);
        // corner lamp post with a warm hanging lantern (market glow at a glance)
        const postMat = new THREE.MeshLambertMaterial({ color: 0x523619 });
        const lpost = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.6, 6), postMat); lpost.position.set(2.35, 1.3, 2.35); lpost.castShadow = true; group.add(lpost);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.55), postMat); arm.position.set(2.35, 2.55, 2.6); group.add(arm);
        const chain = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.18, 0.04), new THREE.MeshLambertMaterial({ color: 0x9aa3ad })); chain.position.set(2.35, 2.42, 2.82); group.add(chain);
        const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), new THREE.MeshLambertMaterial({ color: 0xffd98a, emissive: 0x9a6a10 })); lantern.position.set(2.35, 2.24, 2.82); group.add(lantern);
    }

    buildTower(group, civ, age) {
        age = age || 'stone';
        const wood = new THREE.MeshLambertMaterial({ color: 0x6b4a2a });
        const woodDark = new THREE.MeshLambertMaterial({ color: 0x523619 });
        const stone = new THREE.MeshLambertMaterial({ color: 0x9a958c });
        const merlonMat = new THREE.MeshLambertMaterial({ color: 0x837e76 });
        const plankMat = new THREE.MeshLambertMaterial({ color: 0x7d5630 });

        if (age === 'stone') {
            // Wood-beam high seat: four legs, a platform and a guard rail up top.
            [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]].forEach(([x, z]) => { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 3.6, 5), wood); leg.position.set(x, 1.8, z); leg.castShadow = true; group.add(leg); });
            const cross = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.15, 0.15), woodDark); cross.position.set(0, 1.3, 0.9); group.add(cross);
            const platform = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.25, 2.3), plankMat); platform.position.y = 3.65; platform.castShadow = true; group.add(platform);
            [[-1.0, -1.0], [1.0, -1.0], [-1.0, 1.0], [1.0, 1.0]].forEach(([x, z]) => { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 4), wood); r.position.set(x, 4.1, z); group.add(r); });
            const rail = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.1, 0.1), wood); rail.position.set(0, 4.5, -1.0); group.add(rail);
            this._flag(group, civ, 0, 3.9, 0, 1.6);
        } else if (age === 'neolithic') {
            // Crude wooden tower: a rough stack of logs with an open lookout.
            const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 4.2, 2.1), wood); body.position.y = 2.1; body.castShadow = true; group.add(body);
            // visible logs/lashings
            for (let y = 0.7; y < 4.0; y += 1.0) { const band = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.18, 2.25), woodDark); band.position.y = y; group.add(band); }
            const platform = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.25, 2.5), plankMat); platform.position.y = 4.25; platform.castShadow = true; group.add(platform);
            [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]].forEach(([x, z]) => { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 4), wood); r.position.set(x, 4.7, z); group.add(r); });
            this._flag(group, civ, 0, 4.5, 0, 1.7);
        } else if (age === 'bronze') {
            // Proper wooden tower on a stone foundation.
            const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.2, 2.6), stone); base.position.y = 0.6; base.castShadow = true; group.add(base);
            const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 3.8, 2.0), wood); body.position.y = 3.1; body.castShadow = true; group.add(body);
            for (let y = 1.7; y < 4.6; y += 1.0) { const band = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.16, 2.12), woodDark); band.position.y = y; group.add(band); }
            // hoarding/roof platform
            const platform = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.3, 2.5), plankMat); platform.position.y = 5.1; platform.castShadow = true; group.add(platform);
            const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 1.3, 4), woodDark); roof.position.y = 5.9; roof.rotation.y = Math.PI / 4; roof.castShadow = true; group.add(roof);
            const slit = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.0, 0.1), new THREE.MeshLambertMaterial({ color: 0x1c1c1c })); slit.position.set(0, 3.2, 1.02); group.add(slit);
            this._flag(group, civ, 0, 5.9, 0, 1.6);
        } else {
            // Iron: solid stone tower with crenellations.
            const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.5, 5, 10), stone); tower.position.y = 2.5; tower.castShadow = true; group.add(tower);
            for (let a = 0; a < Math.PI * 2 - 0.01; a += Math.PI / 5) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.5), merlonMat); b.position.set(Math.cos(a) * 1.2, 5.25, Math.sin(a) * 1.2); b.castShadow = true; group.add(b); }
            // Slit embedded into the tapered wall (facet sits at ~1.24-1.31 here;
            // at z=1.42 it floated visibly OFF the curved face).
            const slit = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.2, 0.1), new THREE.MeshLambertMaterial({ color: 0x1c1c1c })); slit.position.set(0, 3.2, 1.28); group.add(slit);
            this._flag(group, civ, 0, 5.3, 0, 1.8);
        }
    }

    createBuildingMesh(building) {
        const group = new THREE.Group();

        // Use the civilization colour so the four players are easy to tell apart.
        const civ = (typeof getCivilization === 'function') ? getCivilization(building.civilization) : null;
        const civColor = (civ && civ.color) ? civ.color : building.color;
        building.color = civColor;

        let buildingGeometry, buildingMaterial;

        if (building.underConstruction) {
            this.buildConstructionSite(building, group, civColor);
        } else {
            switch (building.type) {
                case 'town_center':   this.buildTownCenter(group, civColor, building.age); break;
                case 'barracks':      this.buildBarracks(group, civColor); break;
                case 'stable':        this.buildStable(group, civColor); break;
                case 'archery_range': this.buildArcheryRange(group, civColor); break;
                case 'farm':          this.buildFarm(group, building.age); break;
                case 'house':         this.buildHouse(group, civColor, building.age); break;
                case 'temple':        this.buildTemple(group, civColor); break;
                case 'market':        this.buildMarket(group, civColor); break;
                case 'tower':         this.buildTower(group, civColor, building.age); break;
                case 'pyramid':
                case 'akropolis':
                case 'firetemple':
                case 'shrine':
                    this.buildWonderMesh(building, group, civColor); break;
                default: {
                    const def = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 4), new THREE.MeshLambertMaterial({ color: civColor }));
                    def.position.y = 1.5; def.castShadow = true; group.add(def);
                }
            }
        }

        // Health bar background (Sprite always faces camera, no z-fighting)
        const hbY = building.isWonder ? 12.5 : 7; // sit above tall wonders
        const healthBgCanvas = document.createElement('canvas');
        healthBgCanvas.width = 128; healthBgCanvas.height = 16;
        const healthBgCtx = healthBgCanvas.getContext('2d');
        healthBgCtx.fillStyle = '#333333';
        healthBgCtx.fillRect(0, 0, 128, 16);
        const healthBgTexture = new THREE.CanvasTexture(healthBgCanvas);
        const healthBgMat = new THREE.SpriteMaterial({ map: healthBgTexture, depthTest: false, depthWrite: false });
        const healthBg = new THREE.Sprite(healthBgMat);
        healthBg.scale.set(5, 0.3, 1);
        healthBg.position.set(0, hbY, 0); // Center above building
        group.add(healthBg);
        building.healthBarBg = healthBg;

        // Health bar (Sprite always faces camera, no z-fighting)
        const healthCanvas = document.createElement('canvas');
        healthCanvas.width = 128; healthCanvas.height = 16;
        const healthCtx = healthCanvas.getContext('2d');
        healthCtx.fillStyle = '#00ff00';
        healthCtx.fillRect(0, 0, 128, 16);
        const healthTexture = new THREE.CanvasTexture(healthCanvas);
        const healthMat = new THREE.SpriteMaterial({ map: healthTexture, depthTest: false, depthWrite: false });
        const healthBar = new THREE.Sprite(healthMat);
        healthBar.scale.set(4.8, 0.25, 1);
        healthBar.position.set(0, hbY, 0); // Center above building
        group.add(healthBar);

        building.healthBar = healthBar;
        building.healthBarCanvas = healthCanvas;
        building.healthBarCtx = healthCtx;
        building.healthBarTexture = healthTexture;
        building.mesh = group;

        // Floating civ banner over Town Centers: readable from any zoom, so a
        // spectator can tell whose base is whose at a glance. Child of the group,
        // so fog visibility toggling covers it too.
        if (building.type === 'town_center' && typeof getCivilization === 'function') {
            const civ = getCivilization(building.civilization);
            if (civ) {
                const bCanvas = document.createElement('canvas');
                bCanvas.width = 256; bCanvas.height = 64;
                const bctx = bCanvas.getContext('2d');
                const colHex = '#' + (civ.color || 0xffffff).toString(16).padStart(6, '0');
                bctx.fillStyle = 'rgba(10, 14, 24, 0.72)';
                bctx.strokeStyle = colHex;
                bctx.lineWidth = 5;
                const r = 18;
                bctx.beginPath();
                bctx.moveTo(r, 3); bctx.lineTo(256 - r, 3); bctx.arcTo(253, 3, 253, 3 + r, r);
                bctx.lineTo(253, 61 - r); bctx.arcTo(253, 61, 253 - r, 61, r);
                bctx.lineTo(r, 61); bctx.arcTo(3, 61, 3, 61 - r, r);
                bctx.lineTo(3, 3 + r); bctx.arcTo(3, 3, 3 + r, 3, r);
                bctx.closePath(); bctx.fill(); bctx.stroke();
                const name = (typeof t === 'function' ? t('civ.' + building.civilization + '.name') : null) || civ.name || building.civilization;
                bctx.font = 'bold 30px sans-serif';
                bctx.textAlign = 'center';
                bctx.textBaseline = 'middle';
                bctx.fillStyle = colHex;
                bctx.fillText(name, 128, 34);
                const banner = new THREE.Sprite(new THREE.SpriteMaterial({
                    map: new THREE.CanvasTexture(bCanvas), depthTest: false, depthWrite: false
                }));
                banner.position.set(0, hbY + 2.6, 0);
                banner.scale.set(7.5, 1.9, 1);
                group.add(banner);
            }
        }
        
        // Food indicator for farms (Sprite above farm showing food level)
        if (building.type === 'farm') {
            const foodCanvas = document.createElement('canvas');
            foodCanvas.width = 128; foodCanvas.height = 16;
            const foodCtx = foodCanvas.getContext('2d');
            foodCtx.fillStyle = '#333333';
            foodCtx.fillRect(0, 0, 128, 16);
            const foodTexture = new THREE.CanvasTexture(foodCanvas);
            const foodMat = new THREE.SpriteMaterial({ map: foodTexture, depthTest: false, depthWrite: false });
            const foodBar = new THREE.Sprite(foodMat);
            foodBar.scale.set(4.8, 0.25, 1);
            foodBar.position.set(0, 7.5, 0); // Slightly above health bar
            group.add(foodBar);
            
            building.foodBar = foodBar;
            building.foodBarCanvas = foodCanvas;
            building.foodBarCtx = foodCtx;
            building.foodBarTexture = foodTexture;
        }

        this.scene.add(group);
        this.updateBuildingPosition(building);
    }

    updateUnitPosition(unit) {
        if (unit.mesh) {
            unit.mesh.position.set(unit.x, 0, unit.z);
        }
    }

    updateBuildingPosition(building) {
        if (building.mesh) {
            building.mesh.position.set(building.x, 0, building.z);
        }
    }

    updateHealthBars() {
        this.units.forEach(unit => {
            if (unit.healthBar && unit.mesh) {
                const healthPercent = unit.health / unit.maxHealth;
                // Declutter: only show a unit's health bar once it's damaged
                const showBar = healthPercent < 0.999;
                unit.healthBar.visible = showBar;
                if (unit.healthBarBg) unit.healthBarBg.visible = showBar;
                // Sprites auto-face camera, no lookAt needed
                // Update canvas texture for health bar (colored portion on left, dark on right)
                if (unit.healthBarCtx && unit.healthBarTexture) {
                    const ctx = unit.healthBarCtx;
                    const coloredWidth = Math.max(1, Math.floor(64 * healthPercent));
                    let color = '#00ff00';
                    if (healthPercent <= 0.3) color = '#ff0000';
                    else if (healthPercent <= 0.6) color = '#ffff00';
                    // Draw colored portion on left
                    ctx.fillStyle = color;
                    ctx.fillRect(0, 0, coloredWidth, 8);
                    // Draw dark background on right (so it doesn't show through)
                    ctx.fillStyle = '#333333';
                    ctx.fillRect(coloredWidth, 0, 64 - coloredWidth, 8);
                    unit.healthBarTexture.needsUpdate = true;
                }
                // Keep sprite at full size - canvas texture controls the visible portion
                unit.healthBar.scale.set(1.1, 0.1, 1);
                
                // Update resource icon if worker is carrying
                if (unit.resourceIcon && unit.resourceIconCtx && unit.resourceIconTexture) {
                    const ctx = unit.resourceIconCtx;
                    ctx.clearRect(0, 0, 32, 32);
                    
                    if (unit.carryingResource && unit.carryingResourceType) {
                        unit.resourceIcon.visible = true;
                        // Draw resource icon based on type
                        let emoji = '🍖';
                        if (unit.carryingResourceType === 'wood') emoji = '🌲';
                        else if (unit.carryingResourceType === 'stone') emoji = '🪨';
                        else if (unit.carryingResourceType === 'gold') emoji = '🥇';
                        
                        ctx.font = '24px serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(emoji, 16, 16);
                        unit.resourceIconTexture.needsUpdate = true;
                    } else {
                        unit.resourceIcon.visible = false;
                    }
                }
            }
        });

        this.buildings.forEach(building => {
            if (building.healthBar && building.mesh) {
                const healthPercent = building.health / building.maxHealth;
                // Declutter: hide the bar while under construction or at full health
                const showBar = !building.underConstruction && healthPercent < 0.999;
                building.healthBar.visible = showBar;
                if (building.healthBarBg) building.healthBarBg.visible = showBar;
                // Sprites auto-face camera, no lookAt needed
                // Update canvas texture for health bar (colored portion on left, dark on right)
                if (building.healthBarCtx && building.healthBarTexture) {
                    const ctx = building.healthBarCtx;
                    const coloredWidth = Math.max(1, Math.floor(128 * healthPercent));
                    let color = '#00ff00';
                    if (healthPercent <= 0.3) color = '#ff0000';
                    else if (healthPercent <= 0.6) color = '#ffff00';
                    // Draw colored portion on left
                    ctx.fillStyle = color;
                    ctx.fillRect(0, 0, coloredWidth, 16);
                    // Draw dark background on right (so it doesn't show through)
                    ctx.fillStyle = '#333333';
                    ctx.fillRect(coloredWidth, 0, 128 - coloredWidth, 16);
                    building.healthBarTexture.needsUpdate = true;
                }
                // Keep sprite at full size - canvas texture controls the visible portion
                building.healthBar.scale.set(4.8, 0.25, 1);
                
                // Update food indicator for farms
                if (building.foodBar && building.foodBarCtx && building.foodBarTexture) {
                    const foodPercent = building.maxFoodAmount > 0 ? building.foodAmount / building.maxFoodAmount : 0;
                    const ctx = building.foodBarCtx;
                    const coloredWidth = Math.max(1, Math.floor(128 * foodPercent));
                    let color = '#DAA520'; // Golden for food
                    if (foodPercent <= 0.2) color = '#8B4513'; // Brown when low
                    // Draw dark background
                    ctx.fillStyle = '#333333';
                    ctx.fillRect(0, 0, 128, 16);
                    // Draw colored food portion
                    ctx.fillStyle = color;
                    ctx.fillRect(0, 0, coloredWidth, 16);
                    // Draw food amount text
                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 11px Arial';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(Math.floor(building.foodAmount) + '/' + building.maxFoodAmount, 64, 9);
                    building.foodBarTexture.needsUpdate = true;
                }
            }
        });
    }

    selectUnit(unit) {
        // Deselect previous
        this.selectedUnits.forEach(u => {
            if (u.body) u.body.material.emissive.setHex(0x000000);
        });

        this.selectedUnits = [unit];
        unit.selected = true;
        if (unit.body) {
            unit.body.material.emissive.setHex(0x444444);
        }
    }

    selectMultipleUnits(units) {
        this.selectedUnits.forEach(u => {
            if (u.body) u.body.material.emissive.setHex(0x000000);
            u.selected = false;
        });

        this.selectedUnits = units;
        units.forEach(u => {
            u.selected = true;
            if (u.body) u.body.material.emissive.setHex(0x444444);
        });
    }

    deselectAll() {
        // Reset units
        this.selectedUnits.forEach(u => {
            if (u.body) u.body.material.emissive.setHex(0x000000);
            u.selected = false;
        });
        this.selectedUnits = [];
        
        // Reset buildings - use subtle dark gray instead of pure black
        this.buildings.forEach(b => {
            if (b.mesh) {
                b.mesh.children.forEach(child => {
                    if (child.material && child.material.emissive) {
                        child.material.emissive.setHex(0x111111);
                    }
                });
            }
            b.selected = false;
        });
    }

    // Screen-space selection marquee (DOM overlay): the drawn rectangle is exactly
    // what the player drags, under ANY camera rotation or tilt. The old version
    // projected the two corners to the ground and drew a world-space plane, which
    // was always axis-aligned to the map's X/Z — the moment the view was rotated
    // it no longer matched the drag (and the selection test had the same flaw,
    // see input.js onMouseUp). Coordinates are canvas-relative pixels.
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

    // Project a world point to canvas-relative pixel coordinates (null if behind
    // the camera). Companion of the marquee: box selection tests each unit's
    // PROJECTED position against the screen rectangle the player actually drew.
    worldToScreen(x, y, z) {
        const v = new THREE.Vector3(x, y, z).project(this.camera);
        if (v.z > 1) return null;
        return {
            x: (v.x + 1) / 2 * this.renderer.domElement.clientWidth,
            y: (-v.y + 1) / 2 * this.renderer.domElement.clientHeight
        };
    }

    getWorldPositionFromScreen(screenX, screenY) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((screenX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((screenY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObject(this.terrain.ground);

        if (intersects.length > 0) {
            return {
                x: intersects[0].point.x,
                z: intersects[0].point.z
            };
        }
        return null;
    }

    getUnitsAtPosition(x, z, radius = 2, owner = null) {
        return this.units.filter(unit => {
            const dx = unit.x - x;
            const dz = unit.z - z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            if (dist >= radius) return false;
            // If owner filter specified, only return units of that owner
            if (owner && unit.owner !== owner) return false;
            return true;
        });
    }

    // Clickable radius around a unit, proportional to its footprint (~width x 2).
    // Bigger units (cavalry) get a bigger pick area; everything stays comfortably
    // clickable thanks to the floor.
    unitClickRadius(unit) {
        const widths = { cavalry: 1.6, infantry: 1.2, ranged: 1.1, support: 1.1, worker: 1.0 };
        const w = widths[unit.unitType] || widths[unit.type] || 1.1;
        return Math.max(2.0, w * 2);
    }

    // Pick the unit CLOSEST to a clicked point, but only if the point falls inside
    // that unit's clickable radius. Returns null if the click missed every unit.
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
            const dx = building.x - x;
            const dz = building.z - z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            if (dist >= radius) return false;
            // If owner filter specified, only return buildings of that owner
            if (owner && building.owner !== owner) return false;
            return true;
        });
    }

    moveCameraTo(x, z) {
        // Smooth camera movement
        const targetX = x;
        const targetZ = z + 80;
        
        this.animateCamera(targetX, this.cameraPosition.y, targetZ);
    }

    animateCamera(targetX, targetY, targetZ) {
        const startX = this.camera.position.x;
        const startY = this.camera.position.y;
        const startZ = this.camera.position.z;
        const duration = 500; // ms
        const startTime = Date.now();

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            this.camera.position.x = startX + (targetX - startX) * progress;
            this.camera.position.y = startY + (targetY - startY) * progress;
            this.camera.position.z = startZ + (targetZ - startZ) * progress;
            this.camera.lookAt(this.cameraTarget);

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        animate();
    }

    setSize(width, height) {
        if (width > 0 && height > 0) {
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(width, height);
        }
    }

    onWindowResize() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        this.setSize(width, height);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        // Clamp the step so a long gap (tab unfocused -> rAF paused) doesn't make
        // units lurch across the map on the first frame back.
        const deltaTime = Math.min(0.1, this.clock.getDelta());
        const time = Date.now();
        
        // Update camera based on keyboard input
        this.updateCamera(deltaTime * 1000);

        // Gentle water motion (cosmetic): the sea slowly breathes around the island,
        // the surf band pulses with it, and the clouds drift.
        if (this.terrain && this.terrain.water) {
            this.terrain.water.position.y = -2.4 + Math.sin(time / 1700) * 0.14;
        }
        if (this.terrain && this.terrain.foam) {
            this.terrain.foam.material.opacity = 0.34 + 0.14 * Math.sin(time / 1100);
        }
        if (this.cloudLayer) this.cloudLayer.rotation.y += deltaTime * 0.004;

        // Spectator action camera: ease toward the hottest fight, or drift slowly
        // around the map when nothing is burning. Keeps the current zoom/angle
        // (only the look-at point moves); manual input turns the mode off.
        if (typeof game !== 'undefined' && game && game._actionCam && game.spectatorMode && game.gameStarted) {
            const offX = this.camera.position.x - this.cameraTarget.x;
            const offY = this.camera.position.y - this.cameraTarget.y;
            const offZ = this.camera.position.z - this.cameraTarget.z;
            const hot = game.getActionCamTarget();
            if (hot) {
                const k = Math.min(1, deltaTime * 1.6);
                this.cameraTarget.x += (hot.x - this.cameraTarget.x) * k;
                this.cameraTarget.z += (hot.z - this.cameraTarget.z) * k;
            } else {
                const a = 0.00005 * (deltaTime * 1000); // slow cinematic drift
                const cx = this.cameraTarget.x, cz = this.cameraTarget.z;
                this.cameraTarget.x = cx * Math.cos(a) - cz * Math.sin(a);
                this.cameraTarget.z = cx * Math.sin(a) + cz * Math.cos(a);
            }
            this.camera.position.set(this.cameraTarget.x + offX, this.cameraTarget.y + offY, this.cameraTarget.z + offZ);
            this.camera.lookAt(this.cameraTarget);
        }

        // Update unit positions for AI units only (player units are moved by game.js updateWorkerTasks/moveUnits)
        this.units.forEach(unit => {
            // Skip player units - they are moved by game.js to avoid double-movement
            if (unit.owner === 'player') return;
            
            if (unit.isMoving && unit.targetX !== undefined) {
                const dx = unit.targetX - unit.x;
                const dz = unit.targetZ - unit.z;
                const dist = Math.sqrt(dx*dx + dz*dz);

                if (dist > 0.5) {
                    const speed = unit.speed * deltaTime;
                    unit.x += (dx / dist) * speed;
                    unit.z += (dz / dist) * speed;
                    this.updateUnitPosition(unit);
                } else {
                    unit.isMoving = false;
                }
            }
        });

        // Unit separation - push units apart so they don't stack inside buildings
        const SEPARATION_DIST = 1.2;
        const SEPARATION_FORCE = 0.03;
        for (let i = 0; i < this.units.length; i++) {
            for (let j = i + 1; j < this.units.length; j++) {
                const a = this.units[i];
                const b = this.units[j];
                const dx = b.x - a.x;
                const dz = b.z - a.z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                if (dist < SEPARATION_DIST && dist > 0.01) {
                    const push = (SEPARATION_DIST - dist) * SEPARATION_FORCE;
                    const nx = dx / dist;
                    const nz = dz / dist;
                    a.x -= nx * push;
                    a.z -= nz * push;
                    b.x += nx * push;
                    b.z += nz * push;
                    this.updateUnitPosition(a);
                    this.updateUnitPosition(b);
                }
            }
        }

        // Push units away from building centers so they don't get stuck inside building meshes
        // Town Center is 6x6 (extends 3 units from center), so clearance must be > 3
        // Town Center is 6x6 (extends 3 units from center), so clearance must be > 3
        const UNIT_BUILDING_CLEARANCE = 4.5;
        this.units.forEach(unit => {
            this.buildings.forEach(building => {
                // Skip farms - they're walkable (low to ground)
                if (building.type === 'farm') return;
                // Don't push a worker away from the site it is actively building,
                // otherwise it can never reach build range and stalls at the edge.
                if (unit.task === 'building' && unit.buildTarget === building) return;

                const dx = unit.x - building.x;
                const dz = unit.z - building.z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                if (dist < UNIT_BUILDING_CLEARANCE && dist > 0.01) {
                    const push = (UNIT_BUILDING_CLEARANCE - dist) * 0.05;
                    const nx = dx / dist;
                    const nz = dz / dist;
                    unit.x += nx * push;
                    unit.z += nz * push;
                    this.updateUnitPosition(unit);
                }
            });
        });

        // Animations (applied after all position updates)
        this.units.forEach(unit => {
            // Apply animation AFTER updateUnitPosition to preserve Y offset
            if (unit.isHarvesting && unit.mesh) {
                const bobAmount = Math.sin(time / 150) * 0.15;
                unit.mesh.position.y = unit.baseY + bobAmount;
                unit.mesh.rotation.z = Math.sin(time / 200) * 0.1;
            } else if (unit.carryingResource && unit.mesh) {
                // Add carrying animation
                const carryBob = Math.sin(time / 200) * 0.1;
                unit.mesh.position.y = unit.baseY + carryBob;
            } else if (unit.isBuilding && unit.mesh) {
                // Hammering at a construction site: quick work-rock, no bob.
                unit.mesh.position.y = unit.baseY;
                unit.mesh.rotation.z = Math.sin(time / 130) * 0.13;
            } else if (unit.mesh && unit.baseY !== undefined) {
                // Reset position when not harvesting
                unit.mesh.position.y = unit.baseY;
                unit.mesh.rotation.z = 0;
            }
        });

        // Keep the sky centered on the camera and the sun shadow over the view
        if (this.skyDome) this.skyDome.position.copy(this.camera.position);
        if (this.sunLight) {
            const t = this.cameraTarget;
            this.sunLight.target.position.set(t.x, 0, t.z);
            this.sunLight.position.set(t.x + 120, 180, t.z + 80);
        }

        // Animate construction sites (rise with build progress) + idle flourishes
        this.updateBuildingVisuals(time);

        // Pooled combat/death effects (projectiles, flashes, dust, rings)
        this.updateEffects(deltaTime, time);

        this.updateHealthBars();
        this.renderer.render(this.scene, this.camera);
    }

    // Make construction sites visibly rise as they are built; gently bob banners etc.
    updateBuildingVisuals(time) {
        for (const b of this.buildings) {
            if (b.underConstruction && b.buildShell) {
                const pct = Math.min(1, (b.buildProgress || 0) / (b.buildTime || 10000));
                b.buildShell.scale.y = Math.max(0.06, pct);
                if (b.buildShellMat) b.buildShellMat.opacity = 0.55 + 0.4 * pct;
            }
            if (b.isWonder && b.wonderGlow) {
                b.wonderGlow.material.opacity = 0.35 + 0.25 * Math.sin(time / 500);
            }
        }
    }

    // Called by game.completeConstruction(): swap the site for the finished building
    onBuildingCompleted(building) {
        if (!building || !building.mesh) return;
        this.scene.remove(building.mesh);
        if (building.healthBar) this.scene.remove(building.healthBar);
        building.mesh = null;
        this.createBuildingMesh(building);
    }

    // Rebuild a building's mesh in place (used when it morphs to a new epoch).
    rebuildBuildingMesh(building) {
        if (!building || !building.mesh) return;
        this.scene.remove(building.mesh);
        building.mesh = null;
        this.createBuildingMesh(building);
    }

    completeProduction(building) {
        building.isProducing = false;
        building.productionProgress = 0;

        if (building.productionType) {
            const unit = createUnit(building.productionType, building.x, building.z + 3, building.owner, building.civilization, building.owner === 'player' ? game.player.age : 'stone');
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

    // Stop every in-flight effect (rematch): pooled meshes stay for reuse but go
    // invisible; dying ghosts are disposed at once so a collapsing building from
    // the LAST match can't linger into the next one.
    resetEffects() {
        (this._projectiles || []).forEach(p => { p.active = false; p.mesh.visible = false; });
        (this._rings || []).forEach(r => { r.active = false; r.mesh.visible = false; });
        (this._dustPool || []).forEach(d => { d.active = false; d.pts.visible = false; });
        if (this._dying) {
            this._dying.forEach(d => { this.scene.remove(d.mesh); this.disposeObject(d.mesh); });
            this._dying = [];
        }
        if (this._flashing) this._flashing.clear();
    }

    clearScene() {
        this.resetEffects();
        // Remove all units (and free their GPU resources — this runs on every
        // rematch, so skipping disposal here leaked an entire match's meshes).
        this.units.forEach(unit => {
            if (unit.mesh) { this.scene.remove(unit.mesh); this.disposeObject(unit.mesh); }
            if (unit.healthBar) { this.scene.remove(unit.healthBar); this.disposeObject(unit.healthBar); }
        });
        this.units = [];

        // Remove all buildings
        this.buildings.forEach(building => {
            if (building.mesh) { this.scene.remove(building.mesh); this.disposeObject(building.mesh); }
            if (building.healthBar) { this.scene.remove(building.healthBar); this.disposeObject(building.healthBar); }
        });
        this.buildings = [];

        this.deselectAll();
        this.removeBuildingPreview();
        this.isPlacingBuilding = false;
    }

    // Camera rotation with middle mouse button
    onCanvasMouseDown(event) {
        if (event.button === 1) { // Middle mouse button
            this.isMiddleDragging = true;
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
            event.preventDefault();
        } else if (event.button === 0 && typeof game !== 'undefined' && game && game.spectatorMode) {
            // Spectator mode: left-click-drag pans the map (there are no units to select).
            if (game.disableActionCam) game.disableActionCam(); // manual pan wins
            this.isPanDragging = true;
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
            event.preventDefault();
        }
    }

    onCanvasMouseMove(event) {
        if (this.isPanDragging) {
            const dx = event.clientX - this.lastMouseX;
            const dy = event.clientY - this.lastMouseY;
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
            // Scale pan to the current zoom so it feels 1:1 regardless of distance.
            const dist = this.camera.position.distanceTo(this.cameraTarget) || 100;
            const k = dist * 0.0016;
            const angle = Math.atan2(
                this.camera.position.x - this.cameraTarget.x,
                this.camera.position.z - this.cameraTarget.z
            );
            // Grab-and-drag: the world follows the cursor.
            const horizontal = -dx * k;
            const vertical = dy * k;
            const ddx = Math.sin(angle) * -vertical + Math.cos(angle) * horizontal;
            const ddz = Math.cos(angle) * -vertical - Math.sin(angle) * horizontal;
            this.cameraTarget.x += ddx;
            this.cameraTarget.z += ddz;
            this.camera.position.x += ddx;
            this.camera.position.z += ddz;
            this.camera.lookAt(this.cameraTarget);
            return;
        }
        if (this.isMiddleDragging) {
            const dx = event.clientX - this.lastMouseX;
            const dy = event.clientY - this.lastMouseY;

            const yawSensitivity = 0.005;
            const pitchSensitivity = 0.005;

            // Work with the full 3D offset so we can change both yaw (around Y) and
            // pitch (elevation) while keeping the zoom distance constant.
            const offX = this.camera.position.x - this.cameraTarget.x;
            const offY = this.camera.position.y - this.cameraTarget.y;
            const offZ = this.camera.position.z - this.cameraTarget.z;
            const dist = Math.sqrt(offX * offX + offY * offY + offZ * offZ) || 1;
            const horiz = Math.sqrt(offX * offX + offZ * offZ);

            // Yaw: horizontal drag spins the camera around the target.
            const yaw = Math.atan2(offX, offZ) - dx * yawSensitivity;

            // Pitch: vertical drag tilts up/down. Drag up = higher/more top-down,
            // drag down = flatter. Clamp the elevation angle to 15°..75°.
            const MIN_PITCH = 15 * Math.PI / 180;
            const MAX_PITCH = 75 * Math.PI / 180;
            let pitch = Math.atan2(offY, horiz) - dy * pitchSensitivity;
            pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));

            // Recompose the offset at the new yaw/pitch, preserving total distance.
            const newHoriz = Math.cos(pitch) * dist;
            this.camera.position.x = this.cameraTarget.x + Math.sin(yaw) * newHoriz;
            this.camera.position.z = this.cameraTarget.z + Math.cos(yaw) * newHoriz;
            this.camera.position.y = this.cameraTarget.y + Math.sin(pitch) * dist;
            this.camera.lookAt(this.cameraTarget);

            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
        }
    }

    onCanvasMouseUp(event) {
        if (event.button === 1) {
            this.isMiddleDragging = false;
        } else if (event.button === 0) {
            this.isPanDragging = false;
        }
    }

    // True when the event targets a typeable field — used to keep WASD/arrow keys
    // from panning the map while the user is typing (e.g. spectator advice).
    isEditableTarget(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    // Keyboard event handlers for camera panning
    onKeyDown(event) {
        if (this.isEditableTarget(event.target)) { this.keysPressed = {}; return; }
        this.keysPressed[event.key.toLowerCase()] = true;
    }

    onKeyUp(event) {
        this.keysPressed[event.key.toLowerCase()] = false;
    }
    
    // Update camera position based on keyboard input
    // Mouse-wheel zoom: scale the camera's distance to its look-at target.
    onCanvasWheel(e) {
        e.preventDefault();
        const offset = new THREE.Vector3().subVectors(this.camera.position, this.cameraTarget);
        let dist = offset.length() || 1;
        const factor = e.deltaY > 0 ? 1.12 : (1 / 1.12); // scroll down = zoom out
        dist = Math.max(this.minZoom, Math.min(this.maxZoom, dist * factor));
        offset.setLength(dist);
        this.camera.position.copy(this.cameraTarget).add(offset);
        this.camera.lookAt(this.cameraTarget);
    }

    updateCamera(deltaTime) {
        const speed = this.cameraPanSpeed * deltaTime / 16; // Normalize to ~60fps
        const keys = this.keysPressed;
        
        // Calculate pan direction based on camera angle
        const angle = Math.atan2(
            this.camera.position.x - this.cameraTarget.x,
            this.camera.position.z - this.cameraTarget.z
        );
        
        // Forward/backward (W/S or Up/Down arrows)
        const forward = (keys['w'] || keys['arrowup']) ? 1 : 0;
        const backward = (keys['s'] || keys['arrowdown']) ? 1 : 0;
        const vertical = (forward - backward) * speed;
        
        // Left/right (A/D or Left/Right arrows)
        const left = (keys['a'] || keys['arrowleft']) ? 1 : 0;
        const right = (keys['d'] || keys['arrowright']) ? 1 : 0;
        const horizontal = (right - left) * speed;
        
        if (vertical !== 0 || horizontal !== 0) {
            // Calculate movement vectors relative to camera angle
            // Invert vertical because camera looks down at map from positive z
            const dx = Math.sin(angle) * -vertical + Math.cos(angle) * horizontal;
            const dz = Math.cos(angle) * -vertical - Math.sin(angle) * horizontal;
            
            // Move both camera and target
            this.cameraTarget.x += dx;
            this.cameraTarget.z += dz;
            this.camera.position.x += dx;
            this.camera.position.z += dz;
            
            this.camera.lookAt(this.cameraTarget);
        }
    }
    
    // Update building preview position during placement
    updateBuildingPreview(x, z) {
        if (this.buildingPreview && this.isPlacingBuilding) {
            this.buildingPreview.position.set(x, 1.5, z);
            
            // Update color based on validity
            const valid = this.isValidBuildingPosition(x, z, this.placingBuildingType);
            if (this.buildingPreviewMaterial) {
                this.buildingPreviewMaterial.color.setHex(valid ? 0x00ff00 : 0xff0000);
            }
        }
    }

    // Building placement preview
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

        const geometry = isWonder ? new THREE.BoxGeometry(9, 8, 9) : new THREE.BoxGeometry(4, 3, 4);
        this.buildingPreviewMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x00ff00, 
            transparent: true, 
            opacity: 0.5 
        });
        this.buildingPreview = new THREE.Mesh(geometry, this.buildingPreviewMaterial);
        this.buildingPreview.position.set(x, isWonder ? 4 : 1.5, z);
        this.buildingPreview.visible = true;
        this.scene.add(this.buildingPreview);
    }

    removeBuildingPreview() {
        if (this.buildingPreview) {
            this.scene.remove(this.buildingPreview);
            this.buildingPreview.geometry.dispose();
            if (this.buildingPreviewMaterial) {
                this.buildingPreviewMaterial.dispose();
            }
            this.buildingPreview = null;
            this.buildingPreviewMaterial = null;
        }
    }

    isValidBuildingPosition(x, z, buildingType) {
        // Resolve standard buildings AND civ unique buildings (e.g. Wonders).
        let def = BUILDING_DEFS[buildingType];
        if (!def && this.game && this.game.player) {
            const civ = getCivilization(this.game.player.civilization);
            def = (civ?.uniqueBuildings || []).find(b => b.id === buildingType);
        }
        if (!def) return false;
        
        // Check boundaries using actual map size
        const halfSize = (this.terrain ? this.terrain.size : 800) / 2 - 5; // 5 unit margin from edge
        if (x < -halfSize || x > halfSize || z < -halfSize || z > halfSize) return false;
        
        // Keep a walkable gap between buildings so units can path between them
        for (const building of this.buildings) {
            const dx = building.x - x;
            const dz = building.z - z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            const need = (building.type === 'town_center' || building.isWonder) ? 11 : 9;
            if (dist < need) return false;
        }
        
        // Keep an exclusion zone around resource nodes so harvesters can still
        // reach them (scaled to building size). Falls back to a simple radius if
        // the game back-reference isn't available.
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
}
