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
        this.selectionBox = null;
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

        // Create selection box
        const boxGeometry = new THREE.BoxGeometry(1, 0.1, 1);
        const boxMaterial = new THREE.MeshBasicMaterial({ 
            color: 0x00ff00, 
            transparent: true, 
            opacity: 0.3,
            side: THREE.DoubleSide
        });
        this.selectionBox = new THREE.Mesh(boxGeometry, boxMaterial);
        this.selectionBox.visible = false;
        this.scene.add(this.selectionBox);

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
            // Non-cavalry: standard humanoid body
            let bodyGeometry;

            switch(unit.unitType) {
                case 'worker':
                    bodyGeometry = new THREE.CylinderGeometry(0.4, 0.4, 1, 8);
                    break;
                case 'infantry':
                    bodyGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 8);
                    break;
                case 'ranged':
                    bodyGeometry = new THREE.CylinderGeometry(0.4, 0.4, 1.1, 8);
                    break;
                case 'support':
                    bodyGeometry = new THREE.CylinderGeometry(0.4, 0.4, 1.1, 8);
                    break;
                default:
                    bodyGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
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

            // --- Simple 3D equipment for clearer silhouettes ---
            const metalMat = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
            const woodMat = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
            if (unit.unitType === 'infantry') {
                const helm = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), metalMat);
                helm.position.set(0, headY + 0.04, 0); helm.castShadow = true; group.add(helm);
                const spear = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.8, 5), woodMat);
                spear.position.set(0.45, 0.9, 0); spear.castShadow = true; group.add(spear);
                const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 6), metalMat);
                tip.position.set(0.45, 1.85, 0); group.add(tip);
                const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 12), new THREE.MeshLambertMaterial({ color: 0x6b4a2a }));
                shield.rotation.z = Math.PI / 2; shield.position.set(-0.45, 0.7, 0); shield.castShadow = true; group.add(shield);
            } else if (unit.unitType === 'ranged') {
                const bow = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 6, 14, Math.PI * 1.15), woodMat);
                bow.rotation.y = Math.PI / 2; bow.position.set(0.42, 0.85, 0); bow.castShadow = true; group.add(bow);
            } else if (unit.unitType === 'support') {
                const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.7, 5), woodMat);
                staff.position.set(0.38, 0.95, 0); staff.castShadow = true; group.add(staff);
                const orb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), new THREE.MeshLambertMaterial({ color: 0xffe08a }));
                orb.position.set(0.38, 1.85, 0); group.add(orb);
            } else if (unit.unitType === 'worker') {
                const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.95, 5), woodMat);
                handle.position.set(0.35, 0.75, 0); handle.rotation.z = 0.35; handle.castShadow = true; group.add(handle);
                const toolHead = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.13, 0.1), metalMat);
                toolHead.position.set(0.6, 1.1, 0); group.add(toolHead);
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
        const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), crate); c2.position.set(-1.0, 0.28, 3.1); group.add(c2);
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.8, 10), new THREE.MeshLambertMaterial({ color: 0x7a5230 })); barrel.position.set(1.7, 0.4, 3.0); barrel.castShadow = true; group.add(barrel);
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
            const slit = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.2, 0.1), new THREE.MeshLambertMaterial({ color: 0x1c1c1c })); slit.position.set(0, 3.2, 1.42); group.add(slit);
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

    showSelectionBox(x1, y1, x2, y2) {
        this.selectionBox.visible = true;
        
        // Convert screen-space drag coordinates to world-space for the selection box
        const rect = this.renderer.domElement.getBoundingClientRect();
        const screenX1 = x1 + rect.left;
        const screenY1 = y1 + rect.top;
        const screenX2 = x2 + rect.left;
        const screenY2 = y2 + rect.top;
        
        const topLeft = this.getWorldPositionFromScreen(screenX1, screenY1);
        const bottomRight = this.getWorldPositionFromScreen(screenX2, screenY2);
        
        if (!topLeft || !bottomRight) {
            this.selectionBox.visible = false;
            return;
        }
        
        const minX = Math.min(topLeft.x, bottomRight.x);
        const maxX = Math.max(topLeft.x, bottomRight.x);
        const minZ = Math.min(topLeft.z, bottomRight.z);
        const maxZ = Math.max(topLeft.z, bottomRight.z);

        const width = maxX - minX;
        const depth = maxZ - minZ;

        this.selectionBox.position.set(minX + width/2, 0.15, minZ + depth/2);
        this.selectionBox.scale.set(Math.max(width, 0.1), 1, Math.max(depth, 0.1));
    }

    hideSelectionBox() {
        this.selectionBox.visible = false;
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

    clearScene() {
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
