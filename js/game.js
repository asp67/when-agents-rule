// Main game controller
class Game {
    constructor() {
        this.player = {
            units: [],
            buildings: [],
            resources: new ResourceManager(),
            civilization: 'egyptian',
            age: 'stone',
            techCostMultiplier: 1,
            buildingHealthMultiplier: 1,
            researchedTechs: {},  // Track which techs have been researched (one-time purchase)
            workerHarvestBonus: 1.0,
            trainSpeedBonus: 1.0,
            miningBonus: 1.0,
            healthBonus: 1.0,
            attackBonus: 1.0,
            workerSpeedBonus: 1.0,
            workerBuildSpeedBonus: 1.0,
            unlockedBuildings: {},  // Buildings unlocked by techs
            unlockedUnits: {},       // Units unlocked by techs
            currentResearch: null,   // { techId, building, progress, duration }
            currentAgeUpgrade: null  // { targetAge, progress, duration }
        };
        this.aiManager = null;
        this.openAIAIManager = null; // OpenAI-powered AI controller
        this.renderer = null;
        this.inputManager = null;
        this.terrain = null;
        this.ui = null;
        this.gameStarted = false;
        this.spectatorMode = false; // True when human is spectating AI vs AI
        this.wonderTimer = 0;
        this.wonderHeld = false;
        // Seconds a finished Wonder must be HELD to win. Long enough that rivals get a
        // real window to march over and destroy it (a Wonder is an existential threat).
        this.wonderRequired = 600;
        this.gameSpeed = 1;
        this.lastFrameTime = 0;
    }

    init() {
        this.ui = new UIManager(this);
        const container = document.getElementById('gameCanvas');
        this.renderer = new GameRenderer(container);
        this.renderer.game = this; // back-reference (used for civ-aware placement/preview)
        this.terrain = new TerrainManager(this.renderer.scene, 800); // Quadrupled map size
        this.renderer.setTerrain(this.terrain);
        this.inputManager = new InputManager(this.renderer, this);
        this.aiManager = new AIManager(this);
        this.fogOfWar = null;

        // Start screen — unless we just cancelled a game and should land back on a
        // specific menu (set in confirmCancelGame before the reload).
        let returnTo = null;
        try { returnTo = sessionStorage.getItem('altertum_return'); sessionStorage.removeItem('altertum_return'); } catch (e) {}
        if (returnTo === 'arena') {
            this.ui.showStartScreen();
            this.ui.showArenaSetup();
        } else if (returnTo === 'mode') {
            this.ui.showStartScreen();
            this.ui.showGameModeSelection();
        } else {
            this.ui.showStartScreen();
        }
    }

    // Stop the current game (with confirmation) and return to the former menu.
    cancelGame() {
        if (!this.gameStarted) return;
        const inArena = !!this.spectatorMode;
        this.ui.showConfirm(
            inArena ? t('dlg.quitArena') : t('dlg.quitNormal'),
            () => this.confirmCancelGame(),
            { title: t('dlg.quitTitle'), confirmLabel: t('dlg.quitConfirm'), cancelLabel: t('dlg.keepPlaying') }
        );
    }

    confirmCancelGame() {
        // Halt the loop immediately, then do a full, clean reset via reload and
        // route back to the appropriate menu on the next load.
        this.gameStarted = false;
        if (this.ui && this.ui.teardownSpectatorUI) this.ui.teardownSpectatorUI();
        try { sessionStorage.setItem('altertum_return', this.spectatorMode ? 'arena' : 'mode'); } catch (e) {}
        location.reload();
    }

    selectCiv(civId) {
        this.player.civilization = civId;
        // Note: civ bonus is applied in startGame, no need to apply here
        this.startGame('standard', 3);
    }

    showCampaignSelection() {
        this.showCampaignSetup();
    }

    showCampaignSetup() {
        this.ui.showCampaignSetup();
    }

    // The setup screen's Start button — dispatch to the right starter by mode.
    startFromSetup() {
        if (this.ui._setupMode === 'campaign') return this.startCampaignFromSetup();
        return this.startArenaFromSetup();
    }

    showGameModeSelection() {
        this.ui.showGameModeSelection();
    }

    showTutorial() {
        this.ui.showTutorial();
    }

    showStartScreen() {
        this.ui.showStartScreen();
    }

    showArenaSetup() {
        this.ui.showArenaSetup();
    }

    startSpectatorMode() {
        this.spectatorMode = true;
        this.startGame('spectator', 4); // 4 AI players, no human
    }

    // Start a Campaign (single-player) game from the setup screen: the human plays
    // the chosen civ against 1–5 opponents, each controlled by a model or the
    // rule-based AI. Opponents whose endpoints are unreachable fall back to
    // rule-based automatically (see OpenAIAIManager.demoteToRuleBased).
    startCampaignFromSetup() {
        const setup = this.ui.collectCampaignSetup();
        this.spectatorMode = false;
        this.player.civilization = setup.playerCiv;
        this.startGame('campaign', setup.opponents.length, setup.opponents);
    }

    // Start Arena from setup screen with per-player configuration
    async startArenaFromSetup() {
        const setup = this.ui.collectArenaSetup();

        // Validate: every LLM slot must point at a model with an endpoint.
        for (let i = 0; i < setup.length; i++) {
            if (setup[i].type === 'llm' && !(setup[i].connection && setup[i].connection.endpoint)) {
                alert(t('ar.slotNeedsModel', { n: i + 1 }));
                return;
            }
        }

        this.spectatorMode = true;
        this.ui.showScreen('gameScreen');
        this.gameStarted = true;

        // Resize renderer now that container is visible
        setTimeout(() => {
            const width = this.renderer.container.clientWidth;
            const height = this.renderer.container.clientHeight;
            if (width > 0 && height > 0) {
                this.renderer.setSize(width, height);
                this.renderer.camera.aspect = width / height;
                this.renderer.camera.updateProjectionMatrix();
            }
        }, 100);

        // Clear scene
        this.renderer.clearScene();

        // Reset player resources (still needed for UI, even in spectator mode)
        this.player.resources = new ResourceManager(() => {
            if (this.ui) this.ui.refreshActiveMenu();
        });
        this.player.units = [];
        this.player.buildings = [];
        this.player.pendingBuildings = [];
        this.player.age = 'stone';
        this.player.researchedTechs = {};
        this.player.unlockedBuildings = {};
        this.player.unlockedUnits = {};
        this.player.currentResearch = null;
        this.player.currentAgeUpgrade = null;
        this.player.workerHarvestBonus = 1.0;
        this.player.trainSpeedBonus = 1.0;
        this.player.miningBonus = 1.0;
        this.player.healthBonus = 1.0;
        this.player.attackBonus = 1.0;
        this.player.workerSpeedBonus = 1.0;
        this.player.workerBuildSpeedBonus = 1.0;
        this.player.techCostMultiplier = 1;
        this.player.buildingHealthMultiplier = 1;

        // Calculate spawn positions (one per arena participant, 2–4)
        const mapSize = 800;
        const halfSize = mapSize / 2 - 40;
        const numPlayers = setup.length;
        const spawnPositions = [];
        for (let i = 0; i < numPlayers; i++) {
            const angle = (i / numPlayers) * Math.PI * 2 - Math.PI / 2;
            const radius = halfSize * 0.85;
            spawnPositions.push({
                x: Math.cos(angle) * radius,
                z: Math.sin(angle) * radius
            });
        }

        // Regenerate the map FIRST (with the chosen difficulty) so resource counts
        // reflect it and the per-TC clearResourcesNear below acts on fresh nodes.
        this.difficulty = (typeof localStorage !== 'undefined' && localStorage.getItem('difficulty')) || 'easy';
        this.terrain.difficulty = this.difficulty;
        this.terrain.generateTerrain();
        this.renderer.setTerrain(this.terrain);

        // Create AI players based on setup
        this.aiManager.aiPlayers = [];
        for (let i = 0; i < numPlayers; i++) {
            const ai = this.aiManager.addAIPlayer(setup[i].civ, 'medium');
            const spawn = spawnPositions[i];

            // Create town center
            const townCenter = createBuilding('town_center', spawn.x, spawn.z, ai.id, ai.civilization, { age: ai.age });
            if (townCenter) {
                // Clear any resource node sitting on/under the TC so harvesters don't
                // insta-drop (start TCs are placed at fixed spawns without a check).
                if (this.terrain) this.terrain.clearResourcesNear(spawn.x, spawn.z, this.resourceClearance('town_center') + 3);
                ai.buildings.push(townCenter);
                this.renderer.addBuilding(townCenter);
            }

            // Create initial workers
            for (let w = 0; w < 3; w++) {
                const worker = createUnit('worker', spawn.x + (Math.random() - 0.5) * 10, spawn.z + (Math.random() - 0.5) * 10, ai.id, ai.civilization, 'stone');
                if (worker) {
                    ai.units.push(worker);
                    this.renderer.addUnit(worker);
                }
            }

            // Apply civ bonus
            const civ = getCivilization(ai.civilization);
            if (civ.bonus && civ.bonus.effect) {
                civ.bonus.effect(ai);
            }
        }

        // Setup OpenAI controllers for LLM players. Stop any prior manager first so
        // a previous match's in-flight requests can't bleed into this one.
        if (this.openAIAIManager) this.openAIAIManager.stop();
        this.openAIAIManager = new OpenAIAIManager(this);
        await this.openAIAIManager.initFromSetup(setup);

        // Mark LLM-controlled AI players
        for (let i = 0; i < setup.length; i++) {
            if (setup[i].type === 'llm') {
                const ai = this.aiManager.aiPlayers[i];
                this.aiManager.markAsOpenAIControlled(ai.id);
            }
        }

        // Setup fog of war (natural fog for spectator mode, entities always visible)
        if (this.fogOfWar) this.fogOfWar.destroy(); // drop the previous game's fog overlay
        this.fogOfWar = new FogOfWarManager(this);

        // Setup camera for spectator mode — angled overview that frames the battlefield
        // (mouse wheel zooms in/out from here).
        this.renderer.cameraTarget.set(0, 0, 0);
        this.renderer.camera.position.set(0, 205, 265);
        this.renderer.camera.lookAt(0, 0, 0);

        // Setup spectator UI
        this.ui.setupSpectatorUI();

        // Setup minimap click handlers
        this.setupMinimapClickHandlers();

        // Update minimap
        this.updateMinimap();

        // Hide normal HUD (but keep minimap visible for spectator mode)
        document.getElementById('topHUD').style.display = 'none';
        document.getElementById('bottomHUD').style.display = 'none';
        const oppBar = document.getElementById('opponentsBar');
        if (oppBar) oppBar.style.display = 'none';

        // Start game loop
        this.lastFrameTime = Date.now();
        this.wonderTimer = 0;
        this.wonderHeld = false;
        this.gameLoop();
    }

    // opponentConfigs (optional): Campaign per-opponent setup entries
    // ({ civ, type:'ki'|'llm', connection?, systemPrompt? }). When given, opponents
    // use these civs/controllers instead of the round-robin default.
    startGame(mode, numAI, opponentConfigs = null) {
        this.ui.showScreen('gameScreen');
        this.gameStarted = true;

        // In spectator mode, reset spectatorMode flag (it was set by startSpectatorMode)
        // spectatorMode is already true from startSpectatorMode()

        // Resize renderer now that container is visible
        setTimeout(() => {
            const width = this.renderer.container.clientWidth;
            const height = this.renderer.container.clientHeight;
            if (width > 0 && height > 0) {
                this.renderer.setSize(width, height);
                this.renderer.camera.aspect = width / height;
                this.renderer.camera.updateProjectionMatrix();
            }
        }, 100);

        // Clear scene
        this.renderer.clearScene();

        // Reset player resources (still needed for UI, even in spectator mode)
        this.player.resources = new ResourceManager(() => {
            if (this.ui) this.ui.refreshActiveMenu();
        });
        this.player.units = [];
        this.player.buildings = [];
        this.player.pendingBuildings = [];
        this.player.age = 'stone';
        this.player.techCostMultiplier = 1;
        this.player.buildingHealthMultiplier = 1;
        this.player.researchedTechs = {};
        this.player.workerHarvestBonus = 1.0;
        this.player.trainSpeedBonus = 1.0;
        this.player.miningBonus = 1.0;
        this.player.healthBonus = 1.0;
        this.player.attackBonus = 1.0;
        this.player.workerSpeedBonus = 1.0;
        this.player.workerBuildSpeedBonus = 1.0;
        this.player.unlockedBuildings = {};
        this.player.unlockedUnits = {};
        this.player.currentResearch = null;
        this.player.currentAgeUpgrade = null;

        // Calculate spawn positions for all players
        // In spectator mode: 4 AI players only. In standard mode: 1 human + numAI
        const mapSize = 800;
        const halfSize = mapSize / 2 - 40; // Offset from edge
        const totalPlayers = this.spectatorMode ? numAI : (1 + numAI);
        const spawnPositions = [];
        
        // Distribute spawn points around the map
        for (let i = 0; i < totalPlayers; i++) {
            const angle = (i / totalPlayers) * Math.PI * 2 - Math.PI / 2; // Start from top
            const radius = halfSize * 0.85; // 85% of half-size
            spawnPositions.push({
                x: Math.cos(angle) * radius,
                z: Math.sin(angle) * radius
            });
        }

        // Regenerate the map with the chosen difficulty (fresh resources each game,
        // scaled by difficulty) before placing Town Centers / clearing nodes under them.
        this.difficulty = (typeof localStorage !== 'undefined' && localStorage.getItem('difficulty')) || 'easy';
        this.terrain.difficulty = this.difficulty;
        this.terrain.generateTerrain();
        this.renderer.setTerrain(this.terrain);

        // In standard mode, create player town center at first spawn position
        if (!this.spectatorMode) {
            // Re-apply civ bonus (was set in selectCiv, but startGame may be called directly)
            const civ = getCivilization(this.player.civilization);
            if (civ.bonus) {
                civ.bonus.effect(this.player);
            }

            const playerSpawn = spawnPositions[0];
            const townCenter = createBuilding('town_center', playerSpawn.x, playerSpawn.z, 'player', this.player.civilization, { age: this.player.age });
            if (this.terrain) this.terrain.clearResourcesNear(playerSpawn.x, playerSpawn.z, this.resourceClearance('town_center') + 3);
            this.player.buildings.push(townCenter);
            this.renderer.addBuilding(townCenter);

            // Create initial workers near player town center
            for (let i = 0; i < 3; i++) {
                const worker = createUnit('worker', 
                    playerSpawn.x + (Math.random() - 0.5) * 10, 
                    playerSpawn.z + (Math.random() - 0.5) * 10, 
                    'player', this.player.civilization, 'stone');
                this.player.units.push(worker);
                this.renderer.addUnit(worker);
            }
            // Update population counter after creating workers
            this.player.resources.updatePopulation(this.player.units.length);
        }

        // Add AI opponents at their spawn positions
        const civIds = Object.keys(CIVILIZATIONS);
        const aiStartIndex = this.spectatorMode ? 0 : 1; // In spectator mode, AI starts at spawn 0
        const aiCivs = this.spectatorMode 
            ? civIds // Use all civs in spectator mode
            : civIds.filter(id => id !== this.player.civilization);
        
        for (let i = 0; i < numAI; i++) {
            const aiCiv = (opponentConfigs && opponentConfigs[i] && opponentConfigs[i].civ)
                ? opponentConfigs[i].civ
                : aiCivs[i % aiCivs.length];
            const ai = this.aiManager.addAIPlayer(aiCiv, 'medium');
            
            // Create AI town center at their spawn position
            const aiSpawn = spawnPositions[aiStartIndex + i];
            const aiTC = createBuilding('town_center', aiSpawn.x, aiSpawn.z, ai.id, aiCiv, { age: ai.age });
            if (this.terrain) this.terrain.clearResourcesNear(aiSpawn.x, aiSpawn.z, this.resourceClearance('town_center') + 3);
            ai.buildings.push(aiTC);
            this.renderer.addBuilding(aiTC);

            // Create AI workers near their town center
            for (let j = 0; j < 3; j++) {
                const aiWorker = createUnit('worker', 
                    aiSpawn.x + (Math.random() - 0.5) * 10, 
                    aiSpawn.z + (Math.random() - 0.5) * 10, 
                    ai.id, aiCiv, 'stone');
                ai.units.push(aiWorker);
                this.renderer.addUnit(aiWorker);
            }
        }

        // Initialize OpenAI-powered AI controllers for all AI players (async).
        // Stop any prior manager first so an old match's requests don't bleed in.
        if (this.openAIAIManager) this.openAIAIManager.stop();
        this.openAIAIManager = new OpenAIAIManager(this);
        if (opponentConfigs) {
            // Campaign: each opponent is explicitly a model or the rule-based AI.
            // Build controllers from the setup, then mark ONLY the LLM ones so the
            // rule-based brain keeps driving the rule-based opponents.
            this.openAIAIManager.initFromSetup(opponentConfigs).then(() => {
                for (let i = 0; i < opponentConfigs.length; i++) {
                    if (opponentConfigs[i].type === 'llm') {
                        const ai = this.aiManager.aiPlayers[i];
                        if (ai) this.aiManager.markAsOpenAIControlled(ai.id);
                    }
                }
                console.log('[Game] Campaign AI controllers ready');
                if (this.ui.updateOpponentsPanel) this.ui.updateOpponentsPanel();
            }).catch(err => {
                console.error('[Game] Campaign AI init failed:', err);
            });
        } else {
            this.openAIAIManager.initAndAssign().then(() => {
                console.log('[Game] OpenAI AI controllers ready');
                if (this.ui.updateOpponentsPanel) this.ui.updateOpponentsPanel();
            }).catch(err => {
                console.error('[Game] OpenAI AI init failed:', err);
            });
            // Mark AI players as OpenAI-controlled so the rule-based AI skips them
            this.aiManager.aiPlayers.forEach(ai => {
                this.aiManager.markAsOpenAIControlled(ai.id);
            });
        }

        // Position camera
        if (this.spectatorMode) {
            // Top-down overview for spectator
            this.renderer.cameraPosition = { x: 0, y: 120, z: 120 };
            this.renderer.camera.position.set(0, 120, 120);
            this.renderer.cameraTarget.set(0, 0, 0);
            this.renderer.camera.lookAt(this.renderer.cameraTarget);
        } else {
            // Position camera to show player's starting area
            const playerSpawn = spawnPositions[0];
            this.renderer.cameraPosition = { x: playerSpawn.x, y: 80, z: playerSpawn.z + 80 };
            this.renderer.camera.position.set(playerSpawn.x, 80, playerSpawn.z + 80);
            this.renderer.cameraTarget.set(playerSpawn.x, 0, playerSpawn.z);
            this.renderer.camera.lookAt(this.renderer.cameraTarget);
        }

        // Initialize fog of war
        if (this.fogOfWar) this.fogOfWar.destroy(); // drop the previous game's fog overlay
        this.fogOfWar = new FogOfWarManager(this);
        if (!this.spectatorMode) {
            this.fogOfWar.revealStartingArea();
        }

        // Update minimap
        this.updateMinimap();
        
        // Setup minimap click handlers
        this.setupMinimapClickHandlers();
        
        // Setup spectator UI if in spectator mode
        if (this.spectatorMode) {
            this.ui.setupSpectatorUI();
        }
        
        // Start game loop
        this.lastFrameTime = Date.now();
        this.gameLoop();
    }
    
    // Center the spectator camera on an AI player's base (same as clicking its
    // town center on the minimap). Triggered by clicking a leaderboard card.
    focusCameraOnAI(aiId) {
        const ai = this.aiManager.aiPlayers.find(a => a.id === aiId);
        if (!ai) return;
        const target = ai.buildings.find(b => b.type === 'town_center')
            || ai.buildings[0] || (ai.units && ai.units[0]);
        if (!target) return;
        this.renderer.cameraTarget.set(target.x, 0, target.z);
        this.renderer.moveCameraTo(target.x, target.z);
    }

    setupMinimapClickHandlers() {
        const canvas = document.getElementById('minimapCanvas');
        // This runs on EVERY match start but the canvas element persists across
        // matches — without this guard the listeners stacked up, one more per game.
        if (this._minimapHandlersInstalled) return;
        this._minimapHandlersInstalled = true;

        // Prevent context menu on right-click
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        
        canvas.addEventListener('mousedown', (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Convert minimap pixel to world coordinates. Use the DISPLAYED size
            // (rect.width/height), not the canvas buffer size — the minimap is
            // CSS-scaled (e.g. smaller in spectator mode), so a fixed 300 would
            // misplace clicks.
            const terrainData = this.terrain.getMinimapData();
            const worldX = (x / rect.width) * terrainData.size - terrainData.size / 2;
            const worldZ = (y / rect.height) * terrainData.size - terrainData.size / 2;

            if (e.button === 0) {
                // Left click: move camera to clicked position
                this.renderer.cameraTarget.set(worldX, 0, worldZ);
                this.renderer.moveCameraTo(worldX, worldZ);
            } else if (e.button === 2) {
                // Right click: move selected units to clicked position
                this.moveUnits(worldX, worldZ);
            }
        });
    }

    gameLoop() {
        if (!this.gameStarted) return;

        const currentTime = Date.now();
        let elapsed = currentTime - this.lastFrameTime;
        this.lastFrameTime = currentTime;
        if (!(elapsed > 0)) elapsed = 0;
        // When the tab loses focus the browser throttles (or pauses) requestAnimationFrame,
        // so frames arrive far apart. The OLD code clamped the step to 100ms and DISCARDED
        // the rest, so the game clock fell behind real time — timed mechanics (age-up,
        // research, production) lagged and only "caught up" once focus returned. Instead we
        // keep the full elapsed time (capped so a long hidden period can't freeze us) and
        // feed it to the simulation in safe ≤100ms slices, which keeps timers in sync with
        // real time without a single giant step teleporting units.
        const MAX_CATCHUP = 2000; // ms of real time we'll replay in one frame at most
        const simTime = Math.min(elapsed, MAX_CATCHUP);

        // Coarse, once-per-frame work (AI decision cadence and population don't need slicing).
        this.aiManager.update(simTime);
        if (this.openAIAIManager) {
            this.openAIAIManager.update(simTime);
        }
        this.aiManager.aiPlayers.forEach(ai => {
            ai.resources.updatePopulation(ai.units.length);
        });

        // Fine simulation in ≤100ms sub-steps so the FULL elapsed time is advanced.
        const STEP_MAX = 100;
        let remaining = simTime;
        while (remaining > 0) {
            const step = Math.min(STEP_MAX, remaining);
            this.simulateStep(step);
            remaining -= step;
        }

        // UI / rendering: once per frame.
        this.updateProgressBar();
        this.ui.updateResources(this.player.resources);
        this.ui.updateAge(this.player.age);
        this.checkWinConditions(simTime);

        // Update minimap periodically (every ~500ms)
        if (!this.minimapUpdateTimer) this.minimapUpdateTimer = 0;
        this.minimapUpdateTimer += simTime;
        if (this.minimapUpdateTimer >= 500) {
            this.minimapUpdateTimer = 0;
            this.updateMinimap();
        }

        requestAnimationFrame(() => this.gameLoop());
    }

    // One fixed simulation slice (dt ≤ 100ms). Called once for a normal 60fps frame,
    // or several times to replay a long/throttled frame without losing time.
    simulateStep(dt) {
        // Unit work + movement (movement is the teleport-sensitive part — keep dt small)
        this.updateWorkerTasks(dt);
        this.updateUnitMovement(dt);
        // Timed production / economy
        this.updateProduction(dt);
        this.updateFarmRegeneration(dt);
        // Combat
        this.updateCombat(dt);
        this.updateTowerAttack(dt);
        this.updateAutoDefense(dt);
        // Vision
        if (this.fogOfWar) this.fogOfWar.update(dt);
        // Timed progression (research + age-up) — these must advance in step with real
        // time so the leaderboard age never lags behind the actual game.
        this.updateResearchProgress(dt);
        this.updateAgeUpgradeProgress(dt);
    }

    moveUnits(targetX, targetZ) {
        // In spectator mode, no unit control
        if (this.spectatorMode) return;

        // Only move player-owned selected units
        const selectedUnits = (this.renderer.selectedUnits || this.player.units.filter(u => u.selected))
            .filter(u => u.owner === 'player');
        
        selectedUnits.forEach(unit => {
            // Check if clicking DIRECTLY on a resource node (within small radius)
            const resourceNode = this.findResourceNodeAtPosition(targetX, targetZ);
            
            if (unit.type === 'worker' && resourceNode && resourceNode.isFarm) {
                // Assign worker to farm (dedicated farm worker)
                // First, unassign from any previous farm
                if (unit.farmRef && unit.farmRef.assignedWorker === unit) {
                    unit.farmRef.assignedWorker = null;
                }
                // Cancel any other worker assigned to this farm
                if (resourceNode.farmRef.assignedWorker && resourceNode.farmRef.assignedWorker !== unit) {
                    const oldWorker = resourceNode.farmRef.assignedWorker;
                    oldWorker.task = null;
                    oldWorker.farmRef = null;
                    oldWorker.isMoving = false;
                }
                unit.task = 'farm_work';
                unit.farmRef = resourceNode.farmRef;
                resourceNode.farmRef.assignedWorker = unit;
                // Move worker to the farm
                unit.isMoving = true;
                unit.targetX = resourceNode.farmRef.x + (Math.random() - 0.5) * 3;
                unit.targetZ = resourceNode.farmRef.z + (Math.random() - 0.5) * 3;
                unit.harvestTarget = null;
                unit.carryingResource = false;
            } else if (unit.type === 'worker' && resourceNode) {
                // Send worker to harvest this specific resource
                unit.task = 'harvesting';
                unit.harvestTarget = resourceNode;
                unit.isMoving = true;
                unit.targetX = resourceNode.x;
                unit.targetZ = resourceNode.z;
                unit.carryingResource = false;
                unit.harvestAmount = 0;
                unit.isHarvesting = false;
                unit.harvestTimer = 0;
            } else if (unit.type === 'worker' && this.hasPendingBuildings()) {
                // Send worker to build
                const pendingBuilding = this.player.pendingBuildings[0];
                unit.task = 'building';
                unit.buildTarget = pendingBuilding;
                unit.isMoving = true;
                unit.targetX = pendingBuilding.x;
                unit.targetZ = pendingBuilding.z;
            } else {
                // Move units to the clicked position - clear any existing task
                unit.task = null;
                unit.isMoving = true;
                unit.targetX = targetX;
                unit.targetZ = targetZ;
                unit.isAttacking = false;
                unit.attackTarget = null;
                unit.isHarvesting = false;
                unit.harvestTarget = null;
                unit.harvestTimer = 0;
                unit.carryingResource = false;
                unit.buildTarget = null;
                unit.isBuilding = false;
            }
        });
    }
    
    // Find a resource node at a specific position (within small radius)
    findResourceNodeAtPosition(x, z) {
        let nearest = null;
        let minDist = 1.5; // Very small radius - must click almost directly on the resource
        
        // Check terrain resources
        if (this.terrain && this.terrain.resources) {
            this.terrain.resources.forEach(resource => {
                if (resource.amount <= 0) return;
                const dx = resource.x - x;
                const dz = resource.z - z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                if (dist < minDist) {
                    minDist = dist;
                    nearest = resource;
                }
            });
        }
        
        // Check farms (only player-owned farms)
        const farms = this.getAllBuildings().filter(b => b.type === 'farm' && b.foodAmount > 0 && b.owner === 'player' && !b.underConstruction);
        farms.forEach(farm => {
            const dx = farm.x - x;
            const dz = farm.z - z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            if (dist < minDist) {
                minDist = dist;
                nearest = {
                    type: 'food',
                    x: farm.x,
                    z: farm.z,
                    amount: farm.foodAmount,
                    isFarm: true,
                    farmRef: farm
                };
            }
        });
        
        return nearest;
    }
    
    findNearestResourceNode(x, z) {
        let nearest = null;
        let minDist = Infinity;
        
        // Check terrain resources (trees, animals, stone, gold)
        if (this.terrain && this.terrain.resources) {
            this.terrain.resources.forEach(resource => {
                if (resource.amount <= 0) return;
                const dx = resource.x - x;
                const dz = resource.z - z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                if (dist < minDist && dist < 50) {
                    minDist = dist;
                    nearest = resource;
                }
            });
        }
        
        // Also check farms (only player-owned, they act like renewable food resources)
        const farms = this.getAllBuildings().filter(b => b.type === 'farm' && b.foodAmount > 0 && b.owner === 'player' && !b.underConstruction);
        farms.forEach(farm => {
            const dx = farm.x - x;
            const dz = farm.z - z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            if (dist < minDist && dist < 50) {
                minDist = dist;
                // Create a resource-like object for the farm
                nearest = {
                    type: 'food',
                    x: farm.x,
                    z: farm.z,
                    amount: farm.foodAmount,
                    isFarm: true,
                    farmRef: farm
                };
            }
        });
        
        return nearest;
    }
    
    hasPendingBuildings() {
        return this.player.pendingBuildings && this.player.pendingBuildings.length > 0;
    }

    attackTarget(target) {
        // In spectator mode, no attacks
        if (this.spectatorMode) return;

        // Attack a unit or building
        const selectedUnits = (this.renderer.selectedUnits || this.player.units.filter(u => u.selected))
            .filter(u => u.owner === 'player');
        
        selectedUnits.forEach(unit => {
            unit.isAttacking = true;
            unit.attackTarget = target;
            unit.attackTimer = 0;
            unit.isMoving = true;
            unit.targetX = target.x;
            unit.targetZ = target.z;
        });
    }
    
    // Combat execution for all units (player + AI)
    // Rock-paper-scissors damage multiplier (resolved in the simulation, so the
    // LLM action surface stays small — army composition is what matters).
    // cavalry > ranged > infantry > cavalry; infantry raze buildings; archers don't.
    combatMultiplier(attacker, target) {
        if (!attacker || !target) return 1.0;
        const a = attacker.unitType;
        const targetIsBuilding = (target.type && BUILDING_DEFS[target.type]) || target.isWonder;
        if (targetIsBuilding) {
            if (a === 'infantry') return 1.5;
            if (a === 'cavalry') return 1.0;
            if (a === 'ranged') return 0.5;
            return 0.5; // workers/support
        }
        const t = target.unitType;
        // hard counters
        if (a === 'cavalry' && t === 'ranged') return 1.5;
        if (a === 'ranged' && t === 'infantry') return 1.5;
        if (a === 'infantry' && t === 'cavalry') return 1.5;
        // soft inverse (countered)
        if (a === 'ranged' && t === 'cavalry') return 0.75;
        if (a === 'infantry' && t === 'ranged') return 0.75;
        if (a === 'cavalry' && t === 'infantry') return 0.75;
        return 1.0;
    }

    updateCombat(deltaTime) {
        this.getAllUnits().forEach(unit => {
            // Skip workers - they don't attack unless explicitly ordered
            if (unit.type === 'worker' && !unit.isAttacking) return;
            
            // Drop a dead/destroyed target so we re-acquire below.
            if (unit.isAttacking && unit.attackTarget && unit.attackTarget.health <= 0) {
                unit.attackTarget = null;
            }

            // No target but ordered to fight: acquire the nearest enemy, but ONLY
            // within a reasonable radius — units never hunt clear across the map, so
            // the group stays together instead of one unit wandering off after a
            // far-away enemy (and none get "left behind" at an old corpse). On an
            // attack-move, if nothing is in range they keep marching to the objective.
            if (unit.isAttacking && !unit.attackTarget) {
                // Target scans are O(all units + all buildings) — running one per unit
                // per SUB-STEP melted frames in big battles (catch-up frames run up to
                // 20 sub-steps). Scan at most every 150ms per unit; between scans the
                // unit keeps marching on its attack-move. First scan is immediate.
                unit._acquireTimer = (unit._acquireTimer == null) ? 150 : unit._acquireTimer + deltaTime;
                if (unit._acquireTimer >= 150) {
                    unit._acquireTimer = 0;
                    const aggro = (unit.range > 1 ? unit.range + 20 : 24);
                    const found = this.findNearestEnemyInRange(unit, aggro, true);
                    if (found) {
                        unit.attackTarget = found;
                    } else if (!unit.attackMove) {
                        // Plain attack and nothing nearby (verified by a real scan):
                        // stop instead of chasing far off.
                        unit.isAttacking = false;
                        return;
                    }
                }
                if (!unit.attackTarget) {
                    if (unit.attackMove) {
                        const dx = unit.attackMove.x - unit.x;
                        const dz = unit.attackMove.z - unit.z;
                        const dist = Math.sqrt(dx*dx + dz*dz);
                        if (dist > 1.5) {
                            unit.isMoving = true;
                            const moveSpeed = (unit.speed || 1.0) * deltaTime / 1000 * 3;
                            unit.x += (dx / dist) * moveSpeed;
                            unit.z += (dz / dist) * moveSpeed;
                            this.renderer.updateUnitPosition(unit);
                        } else {
                            // Reached the objective with nothing left to fight: hold.
                            unit.isMoving = false;
                            unit.attackMove = null;
                            unit.isAttacking = false;
                        }
                    }
                    return; // no target yet — either marching or awaiting the next scan
                }
            }

            // Friendly-fire backstop: never damage a same-owner entity, even if a
            // bad order slipped one through. Drop it and re-acquire next tick.
            if (unit.isAttacking && unit.attackTarget &&
                unit.attackTarget.owner != null && unit.attackTarget.owner === unit.owner) {
                unit.attackTarget = null;
                if (!unit.attackMove) unit.isAttacking = false;
            }

            // If unit has an attack target
            if (unit.isAttacking && unit.attackTarget) {
                const currentTarget = unit.attackTarget;
                const dx = currentTarget.x - unit.x;
                const dz = currentTarget.z - unit.z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                
                // Determine attack range (melee = 1.5, ranged = unit.range)
                // For buildings, add building radius so units attack from outside the mesh
                const isBuilding = currentTarget.type && BUILDING_DEFS[currentTarget.type];
                const buildingRadius = isBuilding ? 3.5 : 0; // Approximate building half-size
                const attackRange = (unit.range > 1 ? unit.range : 1.5) + buildingRadius;
                
                if (dist > attackRange) {
                    // Move towards target
                    unit.isMoving = true;
                    unit.targetX = currentTarget.x;
                    unit.targetZ = currentTarget.z;
                    
                    const moveSpeed = (unit.speed || 1.0) * deltaTime / 1000 * 3;
                    unit.x += (dx / dist) * moveSpeed;
                    unit.z += (dz / dist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                } else {
                    // In range - attack!
                    unit.isMoving = false;
                    unit.attackTimer = (unit.attackTimer || 0) + deltaTime;
                    
                    // Attack every 1 second
                    if (unit.attackTimer >= 1000) {
                        unit.attackTimer = 0;

                        // Deal damage (with rock-paper-scissors counter bonus)
                        currentTarget.health -= unit.attack * this.combatMultiplier(unit, currentTarget);
                        // Remember who hit this target & when, for the auto-defense reflex.
                        currentTarget._lastAttacker = unit;
                        currentTarget._lastDamageTime = Date.now();

                        // Visual feedback on health bar
                        if (currentTarget.healthBar) {
                            currentTarget.healthBar.material.color.setHex(0xff0000);
                            setTimeout(() => {
                                if (currentTarget.healthBar) {
                                    const hp = currentTarget.health / currentTarget.maxHealth;
                                    if (hp > 0.6) currentTarget.healthBar.material.color.setHex(0x00ff00);
                                    else if (hp > 0.3) currentTarget.healthBar.material.color.setHex(0xffff00);
                                    else currentTarget.healthBar.material.color.setHex(0xff0000);
                                }
                            }, 100);
                        }
                        
                        // Check if target died
                        if (currentTarget.health <= 0) {
                            this.destroyTarget(currentTarget);
                            unit.attackTarget = null;
                            // On an attack-move, stay aggressive and re-acquire next
                            // tick; a plain attack ends once its target is gone.
                            if (!unit.attackMove) unit.isAttacking = false;
                        }
                    }
                }
            }
        });
    }

    // Nearest living enemy entity (unit, and optionally building) within `range`.
    findNearestEnemyInRange(unit, range, includeBuildings = true) {
        let nearest = null;
        let minDist = range;
        this.renderer.units.forEach(o => {
            if (o.owner === unit.owner || o.health <= 0) return;
            const d = Math.hypot(o.x - unit.x, o.z - unit.z);
            if (d < minDist) { minDist = d; nearest = o; }
        });
        if (includeBuildings) {
            this.renderer.buildings.forEach(b => {
                if (b.owner === unit.owner || b.health <= 0) return;
                const d = Math.hypot(b.x - unit.x, b.z - unit.z);
                if (d < minDist) { minDist = d; nearest = b; }
            });
        }
        return nearest;
    }
    
    // Tower auto-attack: every finished tower fires on EVERY enemy unit within its
    // range each volley (area suppression), so a tower line is a real deterrent.
    updateTowerAttack(deltaTime) {
        const towers = this.getAllBuildings().filter(b => b.type === 'tower' && !b.underConstruction && b.health > 0);
        const units = this.getAllUnits();
        towers.forEach(tower => {
            if (!tower.attackTimer) tower.attackTimer = 0;
            tower.attackTimer += deltaTime;
            if (tower.attackTimer < 1500) return; // fire every 1.5s
            tower.attackTimer = 0;

            const range = tower.range || 6;
            const dmg = tower.attack || 10;

            // Hit every enemy unit in range this volley.
            units.forEach(unit => {
                if (!unit || unit.owner === tower.owner || unit.health <= 0) return;
                const dx = unit.x - tower.x, dz = unit.z - tower.z;
                if (Math.sqrt(dx * dx + dz * dz) > range) return;
                unit.health -= dmg;

                // Brief red flash on the struck unit's health bar.
                if (unit.healthBar) {
                    unit.healthBar.material.color.setHex(0xff0000);
                    setTimeout(() => {
                        if (unit.healthBar) {
                            const hp = unit.health / unit.maxHealth;
                            unit.healthBar.material.color.setHex(hp > 0.6 ? 0x00ff00 : hp > 0.3 ? 0xffff00 : 0xff0000);
                        }
                    }, 100);
                }
                if (unit.health <= 0) this.destroyTarget(unit);
            });
        });
    }
    
    // Priority of a threatened entity (defend the most important first).
    threatPriority(ent) {
        if (ent.isWonder) return 3;
        if (ent.type === 'town_center') return 2;
        if (ent.type && BUILDING_DEFS[ent.type]) return 1;
        return 0;
    }

    // Auto-defense reflex for AI players (rule-based AND LLM): when something on home
    // soil is taking fire, rally idle military to repel the attacker; if there is no
    // army at all, nearby workers grab tools and defend. The human keeps full manual
    // control (not included here).
    updateAutoDefense(deltaTime) {
        this._autoDefTimer = (this._autoDefTimer || 0) + deltaTime;
        if (this._autoDefTimer < 600) return; // throttle (~0.6s) so we don't re-task every frame
        this._autoDefTimer = 0;
        const now = Date.now();

        this.aiManager.aiPlayers.forEach(owner => {
            if (!owner || !owner.units) return;

            // Recent threats: our entities hit in the last 4s by a still-living enemy.
            const threats = [];
            const scan = (ent) => {
                if (!ent || ent.health <= 0) return;
                if (!ent._lastDamageTime || now - ent._lastDamageTime > 4000) return;
                const atk = ent._lastAttacker;
                if (!atk || atk.health <= 0) return;
                if (this.getOwner(atk) === owner) return; // ignore friendly/self
                threats.push({ ent, atk });
            };
            owner.buildings.forEach(scan);
            owner.units.forEach(scan);
            if (!threats.length) return;

            threats.sort((a, b) => this.threatPriority(b.ent) - this.threatPriority(a.ent));
            const primary = threats[0];
            const atk = primary.atk;

            const military = owner.units.filter(u => u.type !== 'worker' && u.health > 0);
            let usingWorkers = false;
            // Idle/free military engage; units already attacking keep their orders.
            let defenders = military.filter(u => !u.isAttacking);
            if (military.length === 0) {
                // No army: pull nearby workers (interrupting their economy) to defend.
                usingWorkers = true;
                defenders = owner.units.filter(u => u.type === 'worker' && u.health > 0 &&
                    Math.hypot(u.x - primary.ent.x, u.z - primary.ent.z) <= 28);
            }
            if (!defenders.length) return;

            defenders.forEach(d => {
                if (usingWorkers) {
                    if (d.farmRef && d.farmRef.assignedWorker === d) d.farmRef.assignedWorker = null;
                    d.farmRef = null;
                    d.isHarvesting = false;
                    d.carryingResource = false;
                }
                d.task = null;
                d.isAttacking = true;
                d.attackTarget = atk;
                d.attackMove = { x: atk.x, z: atk.z }; // pursue & re-acquire nearby threats
                d.attackTimer = 0;
                d.isMoving = true;
                d.targetX = atk.x;
                d.targetZ = atk.z;
            });
        });
    }

    // Find nearest enemy unit to a given unit
    findNearestEnemyUnit(unit) {
        let nearest = null;
        let minDist = Infinity;
        
        this.renderer.units.forEach(other => {
            if (other.owner === unit.owner) return;
            if (other.health <= 0) return;
            const dx = other.x - unit.x;
            const dz = other.z - unit.z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            if (dist < minDist) {
                minDist = dist;
                nearest = other;
            }
        });
        
        return nearest;
    }
    
    // Destroy a target (unit or building)
    destroyTarget(target) {
        if (target.type && BUILDING_DEFS[target.type]) {
            // It's a building
            const owner = target.owner;
            if (owner === 'player') {
                this.removeBuilding(target);
            } else {
                // AI building
                const ai = this.aiManager.aiPlayers.find(a => a.buildings.includes(target));
                if (ai) {
                    const idx = ai.buildings.indexOf(target);
                    if (idx > -1) ai.buildings.splice(idx, 1);
                }
                this.renderer.removeBuilding(target);
            }
        } else {
            // It's a unit
            const owner = target.owner;
            if (owner === 'player') {
                this.removeUnit(target);
            } else {
                // AI unit
                const ai = this.aiManager.aiPlayers.find(a => a.units.includes(target));
                if (ai) {
                    const idx = ai.units.indexOf(target);
                    if (idx > -1) ai.units.splice(idx, 1);
                }
                this.renderer.removeUnit(target);
            }
        }
    }

    isResourceNode(x, z) {
        return this.terrain.resources.some(r => 
            Math.abs(r.x - x) < 3 && Math.abs(r.z - z) < 3
        );
    }

    selectUnit(unit) {
        this.renderer.selectUnit(unit);
        this.ui.updateUnitInfo(unit, null);
    }

    selectBuilding(building) {
        // Deselect previous building first
        if (this.selectedBuilding && this.selectedBuilding !== building) {
            if (this.selectedBuilding.mesh) {
                this.selectedBuilding.mesh.children.forEach(child => {
                    if (child.material && child.material.emissive) {
                        child.material.emissive.setHex(0x111111);
                    }
                });
            }
            this.selectedBuilding.selected = false;
        }
        
        this.renderer.deselectAll();
        building.selected = true;
        this.selectedBuilding = building;
        
        if (building.mesh) {
            building.mesh.children.forEach(child => {
                if (child.material && child.material.emissive) {
                    // Use brighter highlight for selected building
                    child.material.emissive.setHex(0x555555);
                }
            });
        }
        this.ui.updateUnitInfo(null, building);
    }

    buildStructure(buildingType) {
        const civForBuild = getCivilization(this.player.civilization);
        const buildingDef = getBuildingDef(buildingType) ||
            (civForBuild?.uniqueBuildings || []).find(b => b.id === buildingType);
        if (!buildingDef) return;

        // Wonder: Iron-age, one at a time, hold 180s to win.
        if (buildingDef.type === 'wonder') {
            const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
            const reqAge = buildingDef.requiredAge || 'iron';
            if (ageOrder.indexOf(this.player.age) < ageOrder.indexOf(reqAge)) {
                this.ui.showErrorMessage(t('msg.wonderNeedsAge', { age: this.ui.getAgeName(reqAge) }));
                return;
            }
            if (this.player.buildings.some(b => b.isWonder)) {
                this.ui.showErrorMessage(t('msg.wonderAlready'));
                return;
            }
            if (!this.player.resources.hasResources(buildingDef.cost)) {
                this.ui.showErrorMessage(t('msg.notEnough'));
                return;
            }
            this.renderer.isPlacingBuilding = true;
            this.renderer.placingBuildingType = buildingType;
            this.player.pendingBuildings = [{ type: buildingType, def: buildingDef, x: 0, z: 0 }];
            this.renderer.showBuildingPreview(buildingType, 0, 0);
            this.ui.showBuildingPlacementHint(buildingDef.name);
            return;
        }

        // Check if building requires a tech
        if (buildingDef.requiresTech && !this.player.researchedTechs[buildingDef.requiresTech]) {
            const civ = getCivilization(this.player.civilization);
            const tech = civ.techTree[buildingDef.requiresTech];
            this.ui.showErrorMessage(t('msg.needsTech', { tech: tg(tech?.name || buildingDef.requiresTech) }));
            return;
        }

        // Check max farm limit
        if (buildingType === 'farm') {
            const existingFarms = this.player.buildings.filter(b => b.type === 'farm').length;
            if (existingFarms >= 15) {
                this.ui.showErrorMessage(t('msg.maxFarms'));
                return;
            }
        }

        if (!this.player.resources.hasResources(buildingDef.cost)) {
            this.ui.showErrorMessage(t('msg.notEnough'));
            return;
        }

        // Start building placement mode
        this.renderer.isPlacingBuilding = true;
        this.renderer.placingBuildingType = buildingType;
        this.player.pendingBuildings = [{
            type: buildingType,
            def: buildingDef,
            x: 0,
            z: 0
        }];
        
        // Show building preview
        this.renderer.showBuildingPreview(buildingType, 0, 0);
        
        this.ui.showBuildingPlacementHint(buildingDef.name);
    }
    
    confirmBuildingPlacement(x, z) {
        if (!this.player.pendingBuildings || this.player.pendingBuildings.length === 0) return;
        
        const pendingBuilding = this.player.pendingBuildings[0];
        
        // Check if position is valid
        if (!this.renderer.isValidBuildingPosition(x, z, pendingBuilding.type)) {
            this.ui.showErrorMessage(t('msg.badPos'));
            this.cancelBuildingPlacement();
            return;
        }

        // Pick a builder before spending (only idle workers build; a busy worker is
        // borrowed only at the population cap and resumes its task afterwards).
        const pick = this.pickBuilder(this.player, { x, z });
        if (pick.error === 'no_workers') {
            this.ui.showErrorMessage(t('msg.noBuilder'));
            this.cancelBuildingPlacement();
            return;
        }
        if (pick.error === 'no_idle') {
            this.ui.showErrorMessage(t('msg.noIdleBuilder'));
            this.cancelBuildingPlacement();
            return;
        }

        // Spend resources
        this.player.resources.spendResources(pendingBuilding.def.cost);

        // Create a construction site and send the chosen worker to build it
        const building = createBuilding(pendingBuilding.type, x, z, 'player', this.player.civilization, { underConstruction: true, age: this.player.age });
        this.addBuilding(building);
        this.applyBuilder(pick, building);

        // Remove from pending
        this.player.pendingBuildings.shift();
        
        // Cancel placement mode
        this.cancelBuildingPlacement();
        
        this.ui.closeMenus();
    }
    
    cancelBuildingPlacement() {
        this.renderer.isPlacingBuilding = false;
        this.renderer.placingBuildingType = null;
        this.renderer.removeBuildingPreview();
        this.player.pendingBuildings = [];
        this.ui.hideBuildingPlacementHint();
    }

    trainUnit(unitType) {
        const unitDef = getUnitDef(unitType) || getCivilization(this.player.civilization).uniqueUnits.find(u => u.id === unitType);
        if (!unitDef) return;

        // Check population limit
        if (this.player.resources.population >= this.player.resources.maxPopulation) {
            this.ui.showErrorMessage(t('msg.popLimit'));
            return;
        }

        // Buildings (finished) that can train this unit.
        const trainers = this.player.buildings.filter(b => {
            if (b.underConstruction) return false;
            if (b.type === 'town_center' && unitType === 'worker') return true;
            return b.trainOptions && b.trainOptions.includes(unitType);
        });

        if (trainers.length === 0) {
            this.ui.showErrorMessage(t('msg.noTrainBuilding'));
            return;
        }

        // Prefer a FREE one — never silently overwrite a building mid-production.
        const trainingBuilding = trainers.find(b => !b.isProducing);
        if (!trainingBuilding) {
            this.ui.showErrorMessage(t('msg.buildingBusy'));
            return;
        }

        if (!this.player.resources.hasResources(unitDef.cost)) {
            this.ui.showErrorMessage(t('msg.notEnough'));
            return;
        }

        this.player.resources.spendResources(unitDef.cost);
        trainingBuilding.isProducing = true;
        trainingBuilding.productionType = unitType;
        trainingBuilding.productionDuration = 5000;
        trainingBuilding.productionProgress = 0;

        this.ui.closeMenus();
    }

    researchTech(techId, researchBuilding) {
        const civ = getCivilization(this.player.civilization);
        const tech = civ.techTree[techId];
        if (!tech) return;

        // Check if already researched (one-time purchase)
        if (this.player.researchedTechs[techId]) {
            this.ui.showErrorMessage(t('msg.alreadyResearched'));
            return;
        }

        // Check if currently researching
        if (this.player.currentResearch) {
            this.ui.showErrorMessage(t('msg.researching'));
            return;
        }

        // Check if researching at the correct building
        if (tech.researchAt !== researchBuilding?.type) {
            this.ui.showErrorMessage(t('msg.techNotHere'));
            return;
        }

        // Check prerequisites
        if (tech.requires) {
            for (const req of tech.requires) {
                if (!this.player.researchedTechs[req]) {
                    const reqTech = civ.techTree[req];
                    this.ui.showErrorMessage(t('msg.prereqNotResearched', { tech: tg(reqTech?.name || req) }));
                    return;
                }
            }
        }

        // Check age requirement
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        if (tech.requiredAge && ageOrder.indexOf(tech.requiredAge) > ageOrder.indexOf(this.player.age)) {
            this.ui.showErrorMessage(t('msg.techLaterAge'));
            return;
        }

        const costMultiplier = this.player.techCostMultiplier || 1;
        const adjustedCost = {
            food: Math.floor((tech.cost.food || 0) * costMultiplier),
            wood: Math.floor((tech.cost.wood || 0) * costMultiplier),
            stone: Math.floor((tech.cost.stone || 0) * costMultiplier),
            gold: Math.floor((tech.cost.gold || 0) * costMultiplier)
        };

        if (!this.player.resources.hasResources(adjustedCost)) {
            this.ui.showErrorMessage(t('msg.notEnough'));
            return;
        }

        this.player.resources.spendResources(adjustedCost);
        
        // Start research progress
        this.player.currentResearch = {
            techId: techId,
            building: researchBuilding,
            progress: 0,
            duration: tech.researchTime || 15000
        };
        
        this.ui.closeMenus();
    }

    completeResearch(techId, tech, owner) {
        owner = owner || this.player;
        
        // Mark as researched
        owner.researchedTechs[techId] = true;
        
        // Apply tech effect
        this.applyTechEffect(techId, tech, owner);
        
        // Update research options on buildings (only for human player)
        if (owner === this.player) {
            this.updateBuildingResearchOptions();
        }
        
        // Clear current research
        owner.currentResearch = null;
    }

    applyTechEffect(techId, tech, owner) {
        owner = owner || this.player;
        
        // Apply stat bonuses to existing units
        if (tech.bonus) {
            this.applyBonusToUnits(tech.bonus, tech.appliesTo, owner);
        }
        
        // Apply unlocks
        if (tech.unlocks) {
            if (tech.unlocks.buildings) {
                for (const bldg of tech.unlocks.buildings) {
                    owner.unlockedBuildings[bldg] = true;
                }
            }
            if (tech.unlocks.unitTypes) {
                for (const unit of tech.unlocks.unitTypes) {
                    owner.unlockedUnits[unit] = true;
                }
            }
        }
        
        // Apply special bonuses
        if (tech.bonus) {
            if (tech.bonus.harvestRate && tech.appliesTo === 'worker') {
                owner.workerHarvestBonus = (owner.workerHarvestBonus || 1) + tech.bonus.harvestRate;
            }
            if (tech.bonus.buildSpeed && tech.appliesTo === 'worker') {
                owner.workerBuildSpeedBonus = (owner.workerBuildSpeedBonus || 1) + tech.bonus.buildSpeed;
            }
            if (tech.bonus.speed && tech.appliesTo === 'worker') {
                owner.workerSpeedBonus = (owner.workerSpeedBonus || 1) + tech.bonus.speed;
            }
            if (tech.bonus.trainSpeed) {
                owner.trainSpeedBonus = (owner.trainSpeedBonus || 1) + tech.bonus.trainSpeed;
            }
        }
    }

    applyBonusToUnits(bonus, appliesTo, owner) {
        owner = owner || this.player;
        owner.units.forEach(unit => {
            if (unit.type === 'worker' && appliesTo === 'worker') {
                // Apply worker bonuses
                if (bonus.speed) unit.speed *= (1 + bonus.speed);
                if (bonus.harvestRate) unit.harvestRate *= (1 + bonus.harvestRate);
                if (bonus.buildSpeed) unit.buildSpeed *= (1 + bonus.buildSpeed);
            } else if (appliesTo === 'all_military' || appliesTo === unit.unitType) {
                // Apply military bonuses
                if (bonus.attack) unit.attack += bonus.attack;
                if (bonus.health) {
                    unit.health = Math.min(unit.health + bonus.health, unit.maxHealth + bonus.health);
                    unit.maxHealth += bonus.health;
                }
                if (bonus.range) unit.range += bonus.range;
                if (bonus.speed) unit.speed *= (1 + bonus.speed);
            }
        });
        
        // Also update health bars in renderer
        owner.units.forEach(unit => {
            if (unit.healthBar) {
                const hp = unit.health / unit.maxHealth;
                if (hp > 0.6) unit.healthBar.material.color.setHex(0x00ff00);
                else if (hp > 0.3) unit.healthBar.material.color.setHex(0xffff00);
                else unit.healthBar.material.color.setHex(0xff0000);
            }
        });
    }

    updateBuildingResearchOptions() {
        const civ = getCivilization(this.player.civilization);
        const techs = civ.techTree || {};
        
        this.player.buildings.forEach(building => {
            if (building.canResearch) {
                building.researchOptions = Object.keys(techs).filter(techId => {
                    const tech = techs[techId];
                    return tech.researchAt === building.type;
                });
            }
        });
    }

    upgradeAge(newAge) {
        const ages = ['stone', 'neolithic', 'bronze', 'iron'];
        const currentIdx = ages.indexOf(this.player.age);
        const newIdx = ages.indexOf(newAge);

        if (newIdx <= currentIdx) return;

        // Check if currently upgrading
        if (this.player.currentAgeUpgrade) {
            this.ui.showErrorMessage(t('msg.upgradeRunning'));
            return;
        }

        // Shared cost table (civilizations.js) — same numbers the AI/LLM players pay.
        const cost = AGE_COSTS[newAge];
        if (!this.player.resources.hasResources(cost)) {
            this.ui.showErrorMessage(t('msg.notEnough'));
            return;
        }

        this.player.resources.spendResources(cost);
        
        // Start age upgrade progress (30 seconds base)
        this.player.currentAgeUpgrade = {
            targetAge: newAge,
            progress: 0,
            duration: 30000  // 30 seconds for age upgrade
        };

        this.ui.closeMenus();
    }

    completeAgeUpgrade(targetAge, owner) {
        owner = owner || this.player;
        owner.age = targetAge;

        // Update train options for all military buildings based on new age
        if (owner === this.player) {
            this.updateMilitaryTrainOptions();
        } else {
            // Update AI building train options
            owner.buildings.forEach(building => {
                const options = getTrainOptionsForBuilding(building.type, targetAge);
                if (options.length > 0) {
                    building.trainOptions = options;
                }
            });
        }

        // Upgrade existing field units to match new age tier
        this.upgradeFieldUnits(targetAge, owner);

        // Morph existing buildings to the new epoch (look + HP)
        this.morphBuildingsToAge(owner.buildings, targetAge);

        // Unlock new units and buildings
        this.unlockAgeUnits(targetAge, owner);

        // Clear current age upgrade
        owner.currentAgeUpgrade = null;
    }

    // Advance every one of an owner's buildings to a new epoch: rescale HP and
    // rebuild the mesh so a Stone-Age tippy becomes a Neolithic hut, etc.
    morphBuildingsToAge(buildings, newAge) {
        if (!buildings) return;
        buildings.forEach(b => {
            if (upgradeBuildingToAge(b, newAge) && this.renderer && b.mesh) {
                this.renderer.rebuildBuildingMesh(b);
            }
        });
    }

    updateMilitaryTrainOptions() {
        const age = this.player.age;
        this.player.buildings.forEach(building => {
            const options = getTrainOptionsForBuilding(building.type, age);
            if (options.length > 0) {
                building.trainOptions = options;
            }
        });
    }

    upgradeFieldUnits(newAge, owner) {
        owner = owner || this.player;
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const newIdx = ageOrder.indexOf(newAge);

        owner.units.forEach(unit => {
            if (unit.type === 'worker') return; // Workers don't upgrade
            if (unit.currentTier === newAge) return; // Already at this tier

            const upgradePath = UNIT_UPGRADE_PATHS[unit.type];
            if (!upgradePath) return;

            // Find the upgrade target for the new age
            let upgradedType = null;
            for (let i = 0; i <= newIdx; i++) {
                const ageKey = ageOrder[i];
                if (upgradePath[ageKey]) {
                    upgradedType = upgradePath[ageKey];
                }
            }

            if (upgradedType && upgradedType !== unit.type) {
                const newDef = getUnitDef(upgradedType);
                if (newDef) {
                    // Remove old mesh
                    if (unit.mesh) {
                        this.renderer.scene.remove(unit.mesh);
                    }

                    // Upgrade the unit
                    unit.type = upgradedType;
                    unit.name = newDef.name;
                    unit.health = newDef.health;
                    unit.maxHealth = newDef.health;
                    unit.speed = newDef.speed;
                    unit.attack = newDef.attack;
                    unit.range = newDef.range;
                    unit.currentTier = newAge;

                    // Recreate mesh with new type
                    this.renderer.addUnit(unit);
                }
            } else {
                // No upgrade needed, just update tier
                unit.currentTier = newAge;
            }
        });
    }

    unlockAgeUnits(age, owner) {
        owner = owner || this.player;
        switch(age) {
            case 'neolithic':
                // Unlock farms, basic upgrades
                break;
            case 'bronze':
                // Unlock warriors, advanced military
                break;
            case 'iron':
                // Unlock champions, best units
                break;
        }
    }

    showTrainMenu() {
        const selectedBuilding = this.player.buildings.find(b => b.selected);
        this.ui.showTrainMenu(selectedBuilding);
    }

    showResearchMenu() {
        const selectedBuilding = this.player.buildings.find(b => b.selected);
        this.ui.showResearchMenu(selectedBuilding);
    }

    showBuildMenu() {
        const selectedBuilding = this.player.buildings.find(b => b.selected);
        this.ui.showBuildMenu(selectedBuilding?.type);
    }

    showUpgradeMenu() {
        this.ui.showUpgradeMenu();
    }

    closeMenus() {
        this.ui.closeMenus();
    }

    updateUnitInfo(unit, building) {
        this.ui.updateUnitInfo(unit, building);
    }

    addUnit(unit) {
        this.player.units.push(unit);
        this.renderer.addUnit(unit);
        this.player.resources.updatePopulation(this.player.units.length);
    }

    removeUnit(unit) {
        const idx = this.player.units.indexOf(unit);
        if (idx > -1) {
            this.player.units.splice(idx, 1);
            this.renderer.removeUnit(unit);
            this.player.resources.updatePopulation(this.player.units.length);
        }
    }

    addBuilding(building) {
        this.player.buildings.push(building);
        this.renderer.addBuilding(building);

        // Population bonus is granted on completion (see completeConstruction),
        // not while the building is still a construction site.
        if (building.type === 'house' && !building.underConstruction) {
            const def = getBuildingDef('house');
            if (def && def.popBonus) {
                this.player.resources.maxPopulation = Math.min(MAX_POPULATION_CAP, this.player.resources.maxPopulation + def.popBonus);
            }
        }
    }

    // Owner (player or AI) that owns a given building
    getOwnerByBuilding(building) {
        if (this.player.buildings.includes(building)) return this.player;
        return this.aiManager.aiPlayers.find(a => a.buildings.includes(building)) || null;
    }

    // A worker with nothing to do (available to build without disrupting the economy)
    isIdleWorker(u) {
        return u && u.type === 'worker' && u.health > 0 &&
            !u.isBuilding && u.task !== 'building' &&
            u.task !== 'harvesting' && u.task !== 'carrying' && u.task !== 'farm_work' &&
            !u.isHarvesting && !u.carryingResource && !u.farmRef;
    }

    // Decide who builds `site`:
    //   - prefer the closest IDLE worker (never pulls a busy one)
    //   - if there is no idle worker, only borrow the closest busy worker when the
    //     player is at the population cap (can't just train a new one); that worker
    //     resumes its former task afterwards.
    pickBuilder(owner, site, opts = {}) {
        const workers = (owner.units || []).filter(u => u.type === 'worker' && u.health > 0);
        if (!workers.length) return { error: 'no_workers' };
        const closest = arr => {
            let best = null, bd = Infinity;
            arr.forEach(u => { const d = Math.hypot(u.x - site.x, u.z - site.z); if (d < bd) { bd = d; best = u; } });
            return best;
        };
        const idle = workers.filter(u => this.isIdleWorker(u));
        if (idle.length) return { worker: closest(idle), restore: false };

        // No idle worker: borrow a busy one only at the population cap, OR when the
        // caller forces it (the rule-based AI keeps all workers busy, so it must borrow).
        const atMaxPop = owner.resources.population >= owner.resources.maxPopulation;
        if (!atMaxPop && !opts.forceBorrow) return { error: 'no_idle' };
        const borrowable = workers.filter(u => u.task !== 'building' && !u.isBuilding);
        if (!borrowable.length) return { error: 'no_idle' };
        return { worker: closest(borrowable), restore: true };
    }

    // Configure the chosen worker to build `site`, remembering its task if borrowed.
    applyBuilder(pick, site) {
        const w = pick && pick.worker;
        if (!w) return false;
        if (pick.restore) {
            w._formerTask = { task: w.task, harvestTarget: w.harvestTarget, farmRef: w.farmRef };
        } else {
            w._formerTask = null;
        }
        if (w.farmRef && w.farmRef.assignedWorker === w) w.farmRef.assignedWorker = null;
        w.farmRef = null;
        w.task = 'building';
        w.buildTarget = site;
        w.isMoving = false;
        w.isHarvesting = false;
        w.carryingResource = false;
        return true;
    }

    // Convenience pick+apply. Returns 'assigned' | 'borrowed' | 'no_idle' | 'no_workers'.
    assignBuilderTo(owner, site, opts = {}) {
        const pick = this.pickBuilder(owner, site, opts);
        if (pick.error) return pick.error;
        this.applyBuilder(pick, site);
        return pick.restore ? 'borrowed' : 'assigned';
    }

    // Assign specific workers to a friendly building: finish its construction if it
    // is a site, otherwise repair it if damaged. Returns 'building' | 'repairing' | null.
    assignWorkersToBuilding(workers, building) {
        if (!building || !workers || !workers.length) return null;
        const usable = workers.filter(u => u && u.type === 'worker' && u.health > 0);
        if (!usable.length) return null;

        if (building.underConstruction) {
            usable.forEach(w => {
                if (w.farmRef && w.farmRef.assignedWorker === w) w.farmRef.assignedWorker = null;
                w._formerTask = null;
                w.farmRef = null;
                w.task = 'building';
                w.buildTarget = building;
                w.repairTarget = null;
                w.isMoving = false;
                w.isHarvesting = false;
                w.carryingResource = false;
            });
            return 'building';
        }

        if (building.health < building.maxHealth) {
            usable.forEach(w => {
                if (w.farmRef && w.farmRef.assignedWorker === w) w.farmRef.assignedWorker = null;
                w._formerTask = null;
                w.farmRef = null;
                w.task = 'repairing';
                w.repairTarget = building;
                w.buildTarget = null;
                w.isMoving = false;
                w.isHarvesting = false;
                w.carryingResource = false;
            });
            return 'repairing';
        }
        return null;
    }

    // Remove one of `owner`'s own units (e.g. to free population). Cleans up any
    // farm assignment first. Works for the human player and AI players.
    deleteOwnUnit(unit) {
        if (!unit) return false;
        if (unit.farmRef && unit.farmRef.assignedWorker === unit) unit.farmRef.assignedWorker = null;
        unit.health = 0;
        this.destroyTarget(unit);
        return true;
    }

    // Demolish one of `owner`'s own buildings. Reverses its population bonus and
    // frees any farmer. Works for the human player and AI players.
    destroyOwnBuilding(building) {
        if (!building) return false;
        const owner = this.getOwnerByBuilding(building);
        // Reverse the population bonus a FINISHED building granted.
        if (owner && owner.resources && !building.underConstruction) {
            const def = getBuildingDef(building.type);
            if (def && def.popBonus) {
                owner.resources.maxPopulation = Math.max(0, owner.resources.maxPopulation - def.popBonus);
            }
        }
        // Free a farmer tied to this building.
        if (building.assignedWorker) {
            const w = building.assignedWorker;
            if (w.farmRef === building) { w.farmRef = null; w.task = null; }
            building.assignedWorker = null;
        }
        building.health = 0;
        this.destroyTarget(building);
        return true;
    }

    // Clamp a destination to solid ground (off the beach lip / ocean). Land is
    // within ±size/2; the beach starts ~26 units in, so a 30-unit margin keeps
    // units on grass.
    clampToMap(x, z, margin = 30) {
        const half = (this.terrain ? this.terrain.size : 800) / 2 - margin;
        return {
            x: Math.max(-half, Math.min(half, x)),
            z: Math.max(-half, Math.min(half, z))
        };
    }

    // Minimum distance a building's CENTER must keep from a resource node, so a
    // walkable ring is left around the node for harvesters to reach it. Scales with
    // the building's footprint (Town Centers / Wonders are larger).
    resourceClearance(buildingType, isWonder) {
        const half = (buildingType === 'town_center' || isWonder) ? 5 : 3.5;
        return half + 4.5; // ~2 node radius + ~2.5 worker gap
    }

    // True if placing `buildingType` at (x,z) would sit on/too near any live resource.
    isTooCloseToResource(x, z, buildingType, isWonder) {
        const res = this.terrain && this.terrain.resources;
        if (!res) return false;
        const clr = this.resourceClearance(buildingType, isWonder);
        for (const r of res) {
            if (r.amount !== undefined && r.amount <= 0) continue; // depleted node won't block
            if (Math.hypot(r.x - x, r.z - z) < clr) return true;
        }
        return false;
    }

    // Finish a construction site: full HP, becomes functional, grants pop bonus.
    completeConstruction(building) {
        if (!building || !building.underConstruction) return;
        building.underConstruction = false;
        building.buildProgress = building.buildTime || 0;
        building.health = building.maxHealth;
        const owner = this.getOwnerByBuilding(building);
        const def = getBuildingDef(building.type);
        if (def && def.popBonus) {
            if (owner && owner.resources) owner.resources.maxPopulation = Math.min(MAX_POPULATION_CAP, owner.resources.maxPopulation + def.popBonus);
        }
        // Populate train options for military buildings (barracks/stable/archery_range)
        // for THIS owner's age — otherwise LLM/freshly-built buildings can't train.
        if (typeof getTrainOptionsForBuilding === 'function') {
            const opts = getTrainOptionsForBuilding(building.type, owner ? owner.age : 'stone');
            if (opts && opts.length) building.trainOptions = opts;
        }
        if (this.renderer && this.renderer.onBuildingCompleted) {
            this.renderer.onBuildingCompleted(building);
        }
    }

    // An owner's construction site with NO live worker building it (its builder was
    // killed or deleted, so it would otherwise sit half-built forever). Returns the
    // one nearest `unit`, or null if every site already has a builder.
    findOrphanedConstruction(owner, unit) {
        if (!owner || !owner.buildings) return null;
        const units = owner.units || [];
        let best = null, bestD = Infinity;
        for (const b of owner.buildings) {
            if (!b.underConstruction || b.health <= 0) continue;
            const hasBuilder = units.some(u => u && u.health > 0 && u.type === 'worker' &&
                u.task === 'building' && u.buildTarget === b);
            if (hasBuilder) continue;
            if (!unit) return b;
            const d = Math.hypot(b.x - unit.x, b.z - unit.z);
            if (d < bestD) { bestD = d; best = b; }
        }
        return best;
    }

    // Send a worker to (continue) building a site.
    assignWorkerToSite(unit, site) {
        unit.task = 'building';
        unit.buildTarget = site;
        unit.isBuilding = false;
        unit.isMoving = true;
        unit.targetX = site.x;
        unit.targetZ = site.z;
    }

    // Free a worker after it finishes (or loses) a build: resume former task if it
    // was borrowed, become the farmer if it built a farm, otherwise go idle.
    releaseBuilder(unit, site) {
        unit.isBuilding = false;
        unit.task = null;
        unit.buildTarget = null;

        if (unit._formerTask) {
            const f = unit._formerTask;
            unit._formerTask = null;
            if (f.task === 'farm_work' && f.farmRef && f.farmRef.health > 0) {
                f.farmRef.assignedWorker = unit;
                unit.task = 'farm_work';
                unit.farmRef = f.farmRef;
                unit.isMoving = true;
                unit.targetX = f.farmRef.x + (Math.random() - 0.5) * 3;
                unit.targetZ = f.farmRef.z + (Math.random() - 0.5) * 3;
                return;
            }
            if ((f.task === 'harvesting' || f.task === 'carrying') && f.harvestTarget) {
                unit.task = 'harvesting';
                unit.harvestTarget = f.harvestTarget;
                unit.isMoving = true;
                unit.targetX = f.harvestTarget.x;
                unit.targetZ = f.harvestTarget.z;
                unit.carryingResource = false;
                return;
            }
            return; // former task was idle -> stay idle
        }

        // An idle worker that just finished a farm becomes its farmer
        if (site && site.health > 0 && !site.underConstruction && site.type === 'farm' && !site.assignedWorker) {
            site.assignedWorker = unit;
            unit.task = 'farm_work';
            unit.farmRef = site;
            unit.isMoving = true;
            unit.targetX = site.x + (Math.random() - 0.5) * 3;
            unit.targetZ = site.z + (Math.random() - 0.5) * 3;
            return;
        }
        // A worker that just finished building looks for ANOTHER unfinished site with
        // no builder (e.g. one whose worker was killed/deleted) and continues it,
        // instead of going idle — so abandoned construction still gets completed.
        const orphan = this.findOrphanedConstruction(this.getOwner(unit), unit);
        if (orphan) { this.assignWorkerToSite(unit, orphan); return; }
        // Otherwise an idle builder simply goes idle again.
    }

    removeBuilding(building) {
        const idx = this.player.buildings.indexOf(building);
        if (idx > -1) {
            this.player.buildings.splice(idx, 1);
            this.renderer.removeBuilding(building);
        }
    }

    // Get the resource pool for a unit or building's owner
    getOwnerResources(entity) {
        if (entity.owner === 'player') return this.player.resources;
        const ai = this.aiManager.aiPlayers.find(a => a.units.includes(entity) || a.buildings.includes(entity));
        return ai ? ai.resources : null;
    }

    // Get the owner data (player or AI) for a unit or building
    getOwner(entity) {
        if (entity.owner === 'player') return this.player;
        return this.aiManager.aiPlayers.find(a => a.units.includes(entity) || a.buildings.includes(entity));
    }

    // Get all units on the map (player + AI)
    getAllUnits() {
        return this.renderer.units;
    }

    // Get all buildings on the map (player + AI)
    getAllBuildings() {
        return this.renderer.buildings;
    }

    update(deltaTime) {
        this.aiManager.update(deltaTime);
    }

    updateWorkerTasks(deltaTime) {
        this.getAllUnits().forEach(unit => {
            if (unit.type !== 'worker') return;
            
            // Get owner's resources and buildings
            const owner = this.getOwner(unit);
            if (!owner) return;
            const resources = owner.resources;
            const buildings = owner.buildings;
            
            // --- STATE MACHINE: moving, harvesting, carrying, dropping ---
            
            // State 1: Moving to target (resource, town center, or move command)
            if (unit.isMoving) {
                const dx = unit.targetX - unit.x;
                const dz = unit.targetZ - unit.z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                
                // Carriers target the town-center CENTER and "arrive" as soon as they
                // touch its drop radius — so they unload wherever they reach it (any
                // side), instead of all funnelling to one fixed drop point.
                const arrivalThreshold = (unit.task === 'carrying') ? 5.5 :
                                         (unit.task === 'harvesting') ? 2 : 0.5;
                
                if (dist > arrivalThreshold) {
                    const moveSpeed = (unit.speed || 1.0) * deltaTime / 1000 * 3;
                    unit.x += (dx / dist) * moveSpeed;
                    unit.z += (dz / dist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                } else {
                    // Arrived at target
                    unit.isMoving = false;
                    unit.x = unit.targetX;
                    unit.z = unit.targetZ;
                    this.renderer.updateUnitPosition(unit);
                    
                    // If harvesting task and at resource, start harvesting
                    if (unit.task === 'harvesting' && unit.harvestTarget && !unit.carryingResource) {
                        unit.isHarvesting = true;
                        unit.harvestTimer = 0;
                    }
                }
                // While moving, skip other task logic
                return;
            }
            
            // State 2: Harvesting at resource (not moving)
            if (unit.task === 'harvesting' && unit.isHarvesting && unit.harvestTarget) {
                // Node emptied (e.g. by another worker) while we stood on it: stop and
                // go idle so the owner can reassign us to a node that still has goods.
                if (!unit.harvestTarget.isFarm && unit.harvestTarget.amount !== undefined && unit.harvestTarget.amount <= 0) {
                    unit.task = null;
                    unit.harvestTarget = null;
                    unit.isHarvesting = false;
                    return;
                }
                unit.harvestTimer = (unit.harvestTimer || 0) + deltaTime;
                const harvestTime = 2000 / (owner.workerHarvestBonus || 1);

                if (unit.harvestTimer >= harvestTime) {
                    // Collect resource - store it on the worker, don't add to resources yet
                    const resourceType = unit.harvestTarget.type;
                    const amount = 10 * (owner.workerHarvestBonus || 1);
                    
                    // If harvesting from a farm, reduce farm's food amount
                    if (unit.harvestTarget.isFarm && unit.harvestTarget.farmRef) {
                        unit.harvestTarget.farmRef.foodAmount = Math.max(0, unit.harvestTarget.farmRef.foodAmount - amount);
                    } else if (unit.harvestTarget.amount !== undefined) {
                        // Finite nodes: deplete by what was taken. When empty, drop the
                        // node (mesh removed; node kept in place so fog indices hold).
                        unit.harvestTarget.amount = Math.max(0, unit.harvestTarget.amount - amount);
                        if (unit.harvestTarget.amount <= 0 && this.terrain) {
                            this.terrain.depleteResourceNode(unit.harvestTarget);
                        }
                    }

                    // Store resource on worker - will be added to owner's resources when delivered
                    unit.carryingResource = true;
                    unit.carryingResourceType = resourceType;
                    unit.harvestAmount = amount;
                    unit.isHarvesting = false;
                    unit.harvestTimer = 0;
                    
                    // Now move to the CLOSEST town center to drop off (outside building mesh)
                    let closestTC = null;
                    let closestDist = Infinity;
                    buildings.forEach(b => {
                        // Only deliver to FINISHED town centers — a site still under
                        // construction is not a valid drop-off point yet.
                        if (b.type === 'town_center' && !b.underConstruction) {
                            const dx = b.x - unit.x;
                            const dz = b.z - unit.z;
                            const d = Math.sqrt(dx*dx + dz*dz);
                            if (d < closestDist) {
                                closestDist = d;
                                closestTC = b;
                            }
                        }
                    });
                    if (closestTC) {
                        // Head straight for the town centre; the worker drops as soon
                        // as it reaches the drop radius from whatever side it approaches.
                        unit.targetX = closestTC.x;
                        unit.targetZ = closestTC.z;
                        unit.isMoving = true;
                        unit.task = 'carrying';
                    }
                }
                return;
            }
            
            // State 3: Carrying resource to town center (handled by isMoving above)
            // When isMoving completes and task is 'carrying', drop off and return
            if (unit.task === 'carrying' && unit.carryingResource && !unit.isMoving) {
                // Worker has arrived at drop point (isMoving=false means they reached target)
                // NOW add the harvested resource to owner's resources
                if (unit.carryingResourceType && unit.harvestAmount > 0) {
                    resources.addResource(unit.carryingResourceType, unit.harvestAmount);
                }
                
                // Clear carried resource
                unit.carryingResource = false;
                unit.carryingResourceType = null;
                unit.harvestAmount = 0;
                
                // Return to resource to continue harvesting
                if (unit.harvestTarget) {
                    // For farms, check if farm still has food
                    const hasMoreResources = unit.harvestTarget.isFarm 
                        ? (unit.harvestTarget.farmRef && unit.harvestTarget.farmRef.foodAmount > 0)
                        : (unit.harvestTarget.amount > 0);
                    
                    if (hasMoreResources) {
                        unit.targetX = unit.harvestTarget.x + (Math.random() - 0.5) * 2;
                        unit.targetZ = unit.harvestTarget.z + (Math.random() - 0.5) * 2;
                        unit.isMoving = true;
                        unit.task = 'harvesting';
                    } else {
                        // Resource depleted, find new one
                        unit.task = null;
                        unit.harvestTarget = null;
                    }
                }
                // If worker is assigned to a farm, return to it instead
                if (unit.farmRef && unit.farmRef.assignedWorker === unit && unit.farmRef.health > 0) {
                    unit.task = 'farm_work';
                    unit.isMoving = true;
                    unit.targetX = unit.farmRef.x + (Math.random() - 0.5) * 3;
                    unit.targetZ = unit.farmRef.z + (Math.random() - 0.5) * 3;
                }
                return;
            }
            
            // State 4: Building construction — walk to the site, then build it up.
            if (unit.task === 'building' && unit.buildTarget) {
                const site = unit.buildTarget;

                // Site finished (maybe by another worker), destroyed, or gone -> release
                if (!site || site.health <= 0 || !site.underConstruction) {
                    this.releaseBuilder(unit, site);
                    return;
                }

                const dx = site.x - unit.x;
                const dz = site.z - unit.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                const reach = 3.5;

                // Walk to the site (handled inline so it doesn't fight the move state)
                if (dist > reach) {
                    unit.isBuilding = false;
                    const moveSpeed = (unit.speed || 1.0) * deltaTime / 1000 * 3;
                    unit.x += (dx / dist) * moveSpeed;
                    unit.z += (dz / dist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                    return;
                }

                // At the site: contribute build progress (multiple workers stack)
                unit.isBuilding = true;
                const rate = (unit.buildSpeed || 1.0) * (owner.workerBuildSpeedBonus || 1.0);
                site.buildProgress = (site.buildProgress || 0) + deltaTime * rate;
                const pct = Math.min(1, site.buildProgress / (site.buildTime || 10000));
                site.health = Math.max(site.health, site.maxHealth * (0.2 + 0.8 * pct));

                if (site.buildProgress >= (site.buildTime || 10000)) {
                    this.completeConstruction(site);
                    this.releaseBuilder(unit, site);
                }
                return;
            }

            // State 4b: Repairing a damaged building — walk to it, then heal it over time.
            if (unit.task === 'repairing' && unit.repairTarget) {
                const b = unit.repairTarget;
                // Gone, destroyed, or already at full health -> done
                if (!b || b.health <= 0 || b.underConstruction || b.health >= b.maxHealth) {
                    unit.isBuilding = false;
                    unit.task = null;
                    unit.repairTarget = null;
                    return;
                }
                const dx = b.x - unit.x;
                const dz = b.z - unit.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                const reach = 3.5;
                if (dist > reach) {
                    unit.isBuilding = false;
                    const moveSpeed = (unit.speed || 1.0) * deltaTime / 1000 * 3;
                    unit.x += (dx / dist) * moveSpeed;
                    unit.z += (dz / dist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                    return;
                }
                // At the building: restore health (~50 HP/s, workers stack).
                unit.isBuilding = true;
                b.health = Math.min(b.maxHealth, b.health + deltaTime / 1000 * 50);
                if (b.health >= b.maxHealth) {
                    b.health = b.maxHealth;
                    unit.isBuilding = false;
                    unit.task = null;
                    unit.repairTarget = null;
                }
                return;
            }

            // State 5: Farm worker — stays at farm, harvests food when available, carries to TC
            if (unit.task === 'farm_work' && unit.farmRef) {
                const farm = unit.farmRef;
                // Verify farm still exists and is valid
                if (!farm || farm.health <= 0) {
                    // Farm destroyed
                    if (farm && farm.assignedWorker === unit) {
                        farm.assignedWorker = null;
                    }
                    unit.task = null;
                    unit.farmRef = null;
                    // Find new work
                    const nearestResource = this.findNearestResourceNode(unit.x, unit.z);
                    if (nearestResource) {
                        unit.task = 'harvesting';
                        unit.harvestTarget = nearestResource;
                        unit.isMoving = true;
                        unit.targetX = nearestResource.x;
                        unit.targetZ = nearestResource.z;
                    }
                    return;
                }
                
                // Don't farm a field that is still being built — wait by the site.
                if (farm.underConstruction) {
                    unit.isMoving = false;
                    return;
                }

                // Re-assign worker to farm if temporarily unassigned (e.g., during carrying state)
                if (!farm.assignedWorker) {
                    farm.assignedWorker = unit;
                }

                // If farm has food to harvest and worker is not carrying
                if (farm.foodAmount >= 10 && !unit.carryingResource && !unit.isMoving) {
                    // Harvest from farm
                    unit.harvestTimer = (unit.harvestTimer || 0) + deltaTime;
                    const harvestTime = 2000 / (owner.workerHarvestBonus || 1);
                    
                    if (unit.harvestTimer >= harvestTime) {
                        const amount = 10 * (owner.workerHarvestBonus || 1);
                        farm.foodAmount = Math.max(0, farm.foodAmount - amount);
                        
                        unit.carryingResource = true;
                        unit.carryingResourceType = 'food';
                        unit.harvestAmount = amount;
                        unit.harvestTimer = 0;
                        
                        // Move to nearest town center
                        let closestTC = null;
                        let closestDist = Infinity;
                        buildings.forEach(b => {
                            if (b.type === 'town_center' && !b.underConstruction) {
                                const dx = b.x - unit.x;
                                const dz = b.z - unit.z;
                                const d = Math.sqrt(dx*dx + dz*dz);
                                if (d < closestDist) {
                                    closestDist = d;
                                    closestTC = b;
                                }
                            }
                        });
                        if (closestTC) {
                            unit.targetX = closestTC.x;
                            unit.targetZ = closestTC.z;
                            unit.isMoving = true;
                            unit.task = 'carrying';
                        }
                    }
                    return;
                }
                
                // If carrying food to TC, the carrying state handler will take over
                // When returning from TC drop-off, re-assign to farm
                if (unit.task === 'carrying' && unit.carryingResource && !unit.isMoving) {
                    resources.addResource(unit.carryingResourceType, unit.harvestAmount);
                    unit.carryingResource = false;
                    unit.carryingResourceType = null;
                    unit.harvestAmount = 0;
                    
                    // Return to farm
                    unit.task = 'farm_work';
                    unit.isMoving = true;
                    unit.targetX = farm.x + (Math.random() - 0.5) * 3;
                    unit.targetZ = farm.z + (Math.random() - 0.5) * 3;
                    return;
                }
                
                // Worker is idle at farm (waiting for food to regenerate)
                // Stay near the farm
                if (!unit.isMoving) {
                    const dx = farm.x - unit.x;
                    const dz = farm.z - unit.z;
                    const dist = Math.sqrt(dx*dx + dz*dz);
                    if (dist > 3) {
                        unit.isMoving = true;
                        unit.targetX = farm.x + (Math.random() - 0.5) * 2;
                        unit.targetZ = farm.z + (Math.random() - 0.5) * 2;
                    }
                }
            }
            
            // State 6: Idle worker — first resume any abandoned construction site
            // (its builder died/was deleted), then auto-assign to unassigned farms.
            if (!unit.task && !unit.isMoving && !unit.farmRef) {
                const orphanSite = this.findOrphanedConstruction(owner, unit);
                if (orphanSite) { this.assignWorkerToSite(unit, orphanSite); return; }
                // Check for unassigned, FINISHED farms (not still under construction)
                const unassignedFarms = owner.buildings.filter(b =>
                    b.type === 'farm' && !b.assignedWorker && !b.underConstruction
                );
                if (unassignedFarms.length > 0) {
                    // Find nearest unassigned farm
                    let nearestFarm = null;
                    let nearestDist = Infinity;
                    unassignedFarms.forEach(farm => {
                        const dx = farm.x - unit.x;
                        const dz = farm.z - unit.z;
                        const d = Math.sqrt(dx*dx + dz*dz);
                        if (d < nearestDist) {
                            nearestDist = d;
                            nearestFarm = farm;
                        }
                    });
                    
                    if (nearestFarm) {
                        nearestFarm.assignedWorker = unit;
                        unit.task = 'farm_work';
                        unit.farmRef = nearestFarm;
                        unit.isMoving = true;
                        unit.targetX = nearestFarm.x + (Math.random() - 0.5) * 2;
                        unit.targetZ = nearestFarm.z + (Math.random() - 0.5) * 2;
                    }
                }
            }
        });
    }
    
    updateUnitMovement(deltaTime) {
        // Handle movement for non-worker units (military units moving to right-click target)
        this.getAllUnits().forEach(unit => {
            if (unit.type === 'worker') return; // Workers handled in updateWorkerTasks
            if (unit.isAttacking) return; // Attacking units handled in updateCombat
            
            if (unit.isMoving && unit.targetX !== undefined) {
                const dx = unit.targetX - unit.x;
                const dz = unit.targetZ - unit.z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                
                if (dist > 0.5) {
                    const moveSpeed = (unit.speed || 1.0) * deltaTime / 1000 * 3;
                    unit.x += (dx / dist) * moveSpeed;
                    unit.z += (dz / dist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                } else {
                    // Arrived at target - stop moving
                    unit.isMoving = false;
                    unit.x = unit.targetX;
                    unit.z = unit.targetZ;
                    this.renderer.updateUnitPosition(unit);
                }
            }
        });
    }
    
    updateProduction(deltaTime) {
        this.getAllBuildings().forEach(building => {
            if (building.underConstruction) return; // sites can't produce until finished
            if (building.isProducing && building.productionType) {
                building.productionProgress += deltaTime;
                
                // Get owner for train speed bonus
                const owner = this.getOwner(building);
                const trainSpeedBonus = (owner && owner.trainSpeedBonus) || 1;
                const duration = building.productionDuration / trainSpeedBonus;
                
                if (building.productionProgress >= duration) {
                    // Create the unit clearly OUTSIDE the building's footprint (bigger
                    // buildings push the unit further out) so it never spawns half-hidden
                    // inside the mesh.
                    const spawnAngle = Math.random() * Math.PI * 2;
                    const footRadius = (building.isWonder || building.type === 'town_center') ? 5 : 3.5;
                    const spawnDist = footRadius + 3 + Math.random() * 1.5; // clear of the mesh + a little spread
                    const spawnX = building.x + Math.cos(spawnAngle) * spawnDist;
                    const spawnZ = building.z + Math.sin(spawnAngle) * spawnDist;
                    
                    // Determine the age/tier for the unit
                    const age = (owner && owner.age) || 'stone';
                    
                    const unit = createUnit(building.productionType, 
                        spawnX, spawnZ, building.owner, building.civilization, age);
                    if (unit) {
                        // Add to owner's unit list
                        if (building.owner === 'player') {
                            this.player.units.push(unit);
                            this.player.resources.updatePopulation(this.player.units.length);
                        } else {
                            const ai = this.aiManager.aiPlayers.find(a => a.buildings.includes(building));
                            if (ai) {
                                ai.units.push(unit);
                                ai.resources.updatePopulation(ai.units.length);
                            }
                        }
                        this.renderer.addUnit(unit);
                    }
                    // Reset production
                    building.isProducing = false;
                    building.productionType = null;
                    building.productionProgress = 0;
                }
            }
        });
    }
    
    updateFarmRegeneration(deltaTime) {
        // Farms regenerate food over time, but only if a worker is assigned
        const farms = this.getAllBuildings().filter(b => b.type === 'farm' && !b.underConstruction);
        farms.forEach(farm => {
            if (!farm.regenTimer) farm.regenTimer = 0;

            // Farm only regenerates food when a worker is assigned to it
            if (!farm.assignedWorker) return;
            
            // Check if the assigned worker is still alive and still assigned to this farm
            const worker = farm.assignedWorker;
            if (!worker || (worker.task !== 'farm_work' && worker.task !== 'carrying') || !worker.farmRef || worker.farmRef !== farm) {
                farm.assignedWorker = null;
                return;
            }
            
            farm.regenTimer += deltaTime;
            
            // Age-based regeneration rates (per tick):
            // Stone: +10 food / 3s, Neolithic: +15 / 3s, Bronze: +20 / 3s, Iron: +25 / 3s
            const age = farm.owner === 'player' ? this.player.age : 
                        (this.aiManager.aiPlayers.find(a => a.buildings.includes(farm))?.age || 'stone');
            const ageBonus = { stone: 10, neolithic: 15, bronze: 20, iron: 25 };
            const regenAmount = ageBonus[age] || 10;
            
            // Accumulate ticks properly (don't lose partial time)
            while (farm.regenTimer >= 3000) {
                farm.regenTimer -= 3000;
                if (farm.foodAmount < farm.maxFoodAmount) {
                    farm.foodAmount = Math.min(farm.maxFoodAmount, farm.foodAmount + regenAmount);
                }
            }
        });
    }
    
    updateResearchProgress(deltaTime) {
        // Handle human player research
        if (this.player.currentResearch) {
            const research = this.player.currentResearch;
            research.progress += deltaTime;
            
            if (research.progress >= research.duration) {
                const civ = getCivilization(this.player.civilization);
                const tech = civ.techTree[research.techId];
                this.completeResearch(research.techId, tech, this.player);
            }
        }
        
        // Handle AI player research
        this.aiManager.aiPlayers.forEach(ai => {
            if (!ai.currentResearch) return;
            
            const research = ai.currentResearch;
            research.progress += deltaTime;
            
            if (research.progress >= research.duration) {
                const civ = getCivilization(ai.civilization);
                const tech = civ?.techTree?.[research.techId];
                this.completeResearch(research.techId, tech, ai);
            }
        });
    }
    
    updateAgeUpgradeProgress(deltaTime) {
        // Handle human player age upgrade
        if (this.player.currentAgeUpgrade) {
            const upgrade = this.player.currentAgeUpgrade;
            upgrade.progress += deltaTime;
            
            if (upgrade.progress >= upgrade.duration) {
                this.completeAgeUpgrade(upgrade.targetAge, this.player);
            }
        }
        
        // Handle AI player age upgrades
        this.aiManager.aiPlayers.forEach(ai => {
            if (!ai.currentAgeUpgrade) return;
            
            const upgrade = ai.currentAgeUpgrade;
            upgrade.progress += deltaTime;
            
            if (upgrade.progress >= upgrade.duration) {
                this.completeAgeUpgrade(upgrade.targetAge, ai);
            }
        });
    }
    
    updateProgressBar() {
        const progressBar = document.getElementById('productionProgressBar');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        
        if (!progressBar || !progressFill || !progressText) return;
        
        // Check for age upgrade progress first (highest priority)
        if (this.player.currentAgeUpgrade) {
            const upgrade = this.player.currentAgeUpgrade;
            const percentage = Math.min(100, Math.floor((upgrade.progress / upgrade.duration) * 100));
            progressBar.style.display = 'flex';
            progressFill.style.width = percentage + '%';
            progressFill.style.background = 'linear-gradient(90deg, #ffd700, #ff8c00)';
            progressText.textContent = `Aufrüstung: ${percentage}%`;
            return;
        }
        
        // Check for research progress
        if (this.player.currentResearch) {
            const research = this.player.currentResearch;
            const percentage = Math.min(100, Math.floor((research.progress / research.duration) * 100));
            const civ = getCivilization(this.player.civilization);
            const tech = civ.techTree[research.techId];
            progressBar.style.display = 'flex';
            progressFill.style.width = percentage + '%';
            progressFill.style.background = 'linear-gradient(90deg, #4ecca3, #0f3460)';
            progressText.textContent = `Forschung (${tech?.name || '...'}): ${percentage}%`;
            return;
        }
        
        let maxProgress = 0;
        let isProducing = false;
        let unitName = '';
        
        // Find the building with the highest production progress
        this.player.buildings.forEach(building => {
            if (building.isProducing && building.productionType) {
                isProducing = true;
                const trainSpeedBonus = this.player.trainSpeedBonus || 1;
                const duration = building.productionDuration / trainSpeedBonus;
                const progress = building.productionProgress / duration;
                
                if (progress > maxProgress) {
                    maxProgress = progress;
                    unitName = building.productionType;
                }
            }
        });
        
        if (isProducing) {
            progressBar.style.display = 'flex';
            const percentage = Math.min(100, Math.floor(maxProgress * 100));
            progressFill.style.width = percentage + '%';
            progressFill.style.background = 'linear-gradient(90deg, #e94560, #c23152)';
            progressText.textContent = `Produktion: ${percentage}%`;
        } else {
            progressBar.style.display = 'none';
        }
    }
    
    updateMinimap() {
        const canvas = document.getElementById('minimapCanvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 300;
        canvas.height = 300;

        const terrainData = this.terrain.getMinimapData();
        const scale = 300 / terrainData.size;

        // Clear with bright green (visible terrain color matching playing field)
        ctx.fillStyle = '#4a8c3f';
        ctx.fillRect(0, 0, 300, 300);

        // Draw fog of war overlay FIRST (so resources appear on top)
        if (this.fogOfWar) {
            const fogGrid = this.fogOfWar.fogGrid;
            const numTiles = this.fogOfWar.numTiles;
            const minimapSize = 300;
            const tilesPerPixel = numTiles / minimapSize;
            
            const imageData = ctx.getImageData(0, 0, minimapSize, minimapSize);
            const data = imageData.data;
            
            for (let py = 0; py < minimapSize; py++) {
                for (let px = 0; px < minimapSize; px++) {
                    // Sample the center fog tile for this minimap pixel
                    const gx = Math.min(Math.floor(px * tilesPerPixel + tilesPerPixel / 2), numTiles - 1);
                    const gz = Math.min(Math.floor(py * tilesPerPixel + tilesPerPixel / 2), numTiles - 1);
                    const idx = gz * numTiles + gx;
                    const fogValue = fogGrid[idx];
                    
                    const pixelIdx = (py * minimapSize + px) * 4;
                    
                    if (fogValue === 0) {
                        // Unexplored - solid black (matches playing field)
                        data[pixelIdx] = 0;
                        data[pixelIdx + 1] = 0;
                        data[pixelIdx + 2] = 0;
                        data[pixelIdx + 3] = 255;
                    } else if (fogValue === 1) {
                        // Explored but not visible - dim the bright green to dark green (matches playing field)
                        data[pixelIdx] = Math.floor(data[pixelIdx] * 0.7);
                        data[pixelIdx + 1] = Math.floor(data[pixelIdx + 1] * 0.7);
                        data[pixelIdx + 2] = Math.floor(data[pixelIdx + 2] * 0.7);
                        data[pixelIdx + 3] = 255;
                    }
                    // fogValue === 2 (visible) - leave pixel unchanged (bright green)
                }
            }
            
            ctx.putImageData(imageData, 0, 0);
        }

        // Draw resources (only in explored/visible areas) - drawn AFTER fog so they stay visible
        terrainData.resources.forEach(resource => {
            if (resource.amount !== undefined && resource.amount <= 0) return; // depleted
            const x = (resource.x + terrainData.size / 2) * scale;
            const z = (resource.z + terrainData.size / 2) * scale;

            // Only draw resources within minimap bounds
            if (x < 0 || x > 300 || z < 0 || z > 300) return;
            
            // Check fog of war - only show resources in explored areas
            if (this.fogOfWar && !this.fogOfWar.isPositionVisible(resource.x, resource.z)) return;
            
            switch(resource.type) {
                case 'wood': ctx.fillStyle = '#228B22'; break;
                case 'stone': ctx.fillStyle = '#808080'; break;
                case 'gold': ctx.fillStyle = '#FFD700'; break;
                case 'food': ctx.fillStyle = '#8B4513'; break;
            }
            ctx.fillRect(x - 1, z - 1, 2, 2);
        });

        // Draw player buildings (only in explored/visible areas)
        // In spectator mode, skip player (no human player exists)
        if (!this.spectatorMode) {
            this.player.buildings.forEach(building => {
                const x = (building.x + terrainData.size / 2) * scale;
                const z = (building.z + terrainData.size / 2) * scale;
                ctx.fillStyle = '#4ecca3';
                ctx.fillRect(x - 3, z - 3, 6, 6);
            });

            // Draw player units (only in visible areas)
            this.player.units.forEach(unit => {
                const x = (unit.x + terrainData.size / 2) * scale;
                const z = (unit.z + terrainData.size / 2) * scale;
                ctx.fillStyle = '#4169e1';
                ctx.fillRect(x - 2, z - 2, 4, 4);
            });
        }

        // Draw AI players (only in visible areas)
        // In spectator mode, use each AI's civilization color
        this.aiManager.aiPlayers.forEach(ai => {
            const civ = getCivilization(ai.civilization);
            const colorHex = '#' + (civ?.color || 0xff0000).toString(16).padStart(6, '0');
            const unitColor = this.spectatorMode ? colorHex : '#ff4444';
            const buildingColor = this.spectatorMode ? colorHex : '#ff4444';

            ai.buildings.forEach(building => {
                if (this.fogOfWar && !this.fogOfWar.isPositionVisible(building.x, building.z)) return;
                const x = (building.x + terrainData.size / 2) * scale;
                const z = (building.z + terrainData.size / 2) * scale;
                ctx.fillStyle = buildingColor;
                ctx.fillRect(x - 3, z - 3, 6, 6);
            });

            ai.units.forEach(unit => {
                if (this.fogOfWar && !this.fogOfWar.isPositionVisible(unit.x, unit.z)) return;
                const x = (unit.x + terrainData.size / 2) * scale;
                const z = (unit.z + terrainData.size / 2) * scale;
                ctx.fillStyle = unitColor;
                ctx.fillRect(x - 2, z - 2, 4, 4);
            });
        });
    }

    checkWinConditions(deltaTime = 16) {
        // Arena/spectator mode has no human player: decide between the AIs.
        if (this.spectatorMode) {
            this.checkArenaEnd(deltaTime);
            return;
        }

        // Check if player built and holds a wonder
        const playerWonders = this.player.buildings.filter(b =>
            (b.isWonder || b.type === 'pyramid' || b.type === 'akropolis' ||
             b.type === 'firetemple' || b.type === 'shrine') && !b.underConstruction
        );

        if (playerWonders.length > 0) {
            const required = (this.wonderRequired || 240) * 1000;
            this.wonderTimer += deltaTime;
            // Spectacular one-time announcement the moment the Wonder is finished.
            if (!this._wonderAnnounced) {
                this._wonderAnnounced = true;
                this.ui.announceWonder(playerWonders[0]);
            }
            // Live victory countdown overlay.
            this.ui.showWonderTimer(Math.max(0, required - this.wonderTimer), required);
            if (this.wonderTimer >= required) {
                this.ui.hideWonderTimer();
                this.ui.showVictory();
                this.gameStarted = false;
                return;
            }
        } else {
            this.wonderTimer = 0;
            if (this._wonderAnnounced) { this._wonderAnnounced = false; this.ui.hideWonderTimer(); }
        }

        // Check if all AI players are defeated
        const activeAI = this.aiManager.aiPlayers.filter(ai => 
            ai.units.length > 0 || ai.buildings.length > 0
        );

        if (activeAI.length === 0 && this.aiManager.aiPlayers.length > 0) {
            this.ui.showVictory();
            this.gameStarted = false;
            return;
        }

        // Check if player is defeated (skip in spectator mode)
        if (!this.spectatorMode && this.player.units.length === 0 && this.player.buildings.length === 0) {
            this.ui.showDefeat();
            this.gameStarted = false;
            return;
        }
    }

    // A player is ELIMINATED only when it has no way left to EVER field a military
    // unit again. Used consistently for arena win detection AND for stopping a
    // defeated model's LLM pipeline, so the two never disagree:
    //   - still in if it has any military unit;
    //   - still in if it has a finished military building it can afford to produce from;
    //   - otherwise still in only if it can (re)start the chain — it has a Town
    //     Center, OR a worker plus the resources to build a new Town Center.
    isPlayerEliminated(ai) {
        if (!ai) return true;
        if (ai.units && ai.units.some(u => u.type !== 'worker')) return false;      // has an army
        if (this.canAffordAnyMilitary(ai)) return false;                            // can build military now
        if (ai.buildings && ai.buildings.some(b => b.type === 'town_center')) return false; // has a TC
        const tcDef = (typeof getBuildingDef === 'function') ? getBuildingDef('town_center') : null;
        const tcCost = (tcDef && tcDef.cost) || { food: 100, wood: 100, stone: 100, gold: 100 };
        if (ai.units && ai.units.some(u => u.type === 'worker') &&
            ai.resources && ai.resources.hasResources(tcCost)) return false;        // can rebuild a TC
        return true;
    }

    // Can this player afford at least one military unit that one of its FINISHED
    // military buildings can train at its current age?
    canAffordAnyMilitary(ai) {
        if (!ai || !ai.buildings || !ai.resources) return false;
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const aIdx = ageOrder.indexOf(ai.age);
        const trains = {
            barracks: ['militia', 'warrior', 'champion'],
            archery_range: ['archer', 'crossbowman', 'elite_archer'],
            stable: ['scout_cavalry', 'cavalry', 'heavy_cavalry']
        };
        for (const b of ai.buildings) {
            if (b.underConstruction || !trains[b.type]) continue;
            for (const uid of trains[b.type]) {
                const def = (typeof getUnitDef === 'function') ? getUnitDef(uid) : null;
                if (!def) continue;
                if (ageOrder.indexOf(def.tier || 'stone') > aIdx) continue; // not available at this age
                if (ai.resources.hasResources(def.cost)) return true;
            }
        }
        return false;
    }

    // Decide the arena: a held wonder, last player standing, or wipeout.
    checkArenaEnd(deltaTime) {
        const players = this.aiManager.aiPlayers;
        if (!players || players.length === 0) return;

        const wonderTypes = ['pyramid', 'akropolis', 'firetemple', 'shrine'];
        const required = (this.wonderRequired || 180) * 1000;
        let wonderHolder = null;
        players.forEach(ai => {
            const hasWonder = ai.buildings.some(b => (b.isWonder || wonderTypes.includes(b.type)) && !b.underConstruction);
            if (hasWonder) {
                ai._wonderHold = (ai._wonderHold || 0) + deltaTime;
                if (ai._wonderHold >= required) wonderHolder = ai;
            } else {
                ai._wonderHold = 0;
            }
        });
        if (wonderHolder) { this.endArena(wonderHolder, 'wonder'); return; }

        const alive = players.filter(ai => !this.isPlayerEliminated(ai));
        if (alive.length === 1 && players.length > 1) { this.endArena(alive[0], 'last_standing'); return; }
        if (alive.length === 0) { this.endArena(null, 'mutual_destruction'); return; }
    }

    // Stop the match and hand off to the benchmark summary screen.
    endArena(winnerAi, reason) {
        if (!this.gameStarted) return; // guard against double-trigger
        this.gameStarted = false;
        // Halt the LLM pipeline so finished-match requests stop spending quota and
        // can't spawn late units into the scene behind the summary.
        if (this.openAIAIManager) this.openAIAIManager.stop();
        if (this.ui.teardownSpectatorUI) this.ui.teardownSpectatorUI();
        this.ui.showArenaSummary(winnerAi, reason);
    }

    // Triggered by the spectator "Auswertung" button: end now, winner = best score.
    endArenaManually() {
        if (!this.spectatorMode || !this.gameStarted) return;
        const players = this.aiManager.aiPlayers;
        const alive = players.filter(ai => !this.isPlayerEliminated(ai));
        const pool = alive.length ? alive : players;
        let winner = null, best = -Infinity;
        pool.forEach(ai => {
            const p = this.ui.spectatorPowerScore(ai);
            if (p > best) { best = p; winner = ai; }
        });
        const reason = alive.length === 1 ? 'last_standing' : 'manual';
        this.endArena(winner, reason);
    }
}

// Initialize game when page loads
let game;
window.addEventListener('load', () => {
    game = new Game();
    game.init();
});
