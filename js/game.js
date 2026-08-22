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
        // Game time per wall-clock second: 1 | 1.5 | 2. See simBudget — clamped back to
        // 1 while a Wonder stands, because speeding the sim shrinks the number of
        // DECISIONS a seat gets inside that countdown even though the countdown itself
        // scales correctly.
        this.simSpeed = 1;
        // 'running' | 'pausing' | 'paused'. Pause is NOT speed zero: a request already
        // sent cannot be unsent, so pressing pause asks to stop and the world keeps
        // turning until every answer in flight has landed and been applied. Freezing on
        // the press would throw those moves away, and the model would never learn that
        // the turn it spent was discarded.
        this.pauseState = 'running';
        // Seconds a finished Wonder must be HELD to win. Long enough that rivals get a
        // real window to march over and destroy it (a Wonder is an existential threat).
        this.wonderRequired = 600;
        // Exploration bitmap resolution: 42×42 cells (~19 units each), summarised
        // for the models as a 7×7 tile grid of 6×6 cells per tile (see
        // markExploration / explorationSummary).
        this.EXPLORE_GRID = 42;
        this.EXPLORE_TILES = 7;
        this.gameSpeed = 1;
        this.lastFrameTime = 0;
    }

    init() {
        this.ui = new UIManager(this);
        const container = document.getElementById('gameCanvas');
        this.renderer = new EngineRenderer(container); // the in-house engine (M6: only renderer)
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

    // Stop the current game (with confirmation). Arena: end the match and hand
    // off to the evaluation screen (winner by power score, like a manual end) —
    // the summary's own buttons lead on to a new arena or the menu from there.
    // Campaign: reload back to the former menu as before.
    cancelGame() {
        if (!this.gameStarted) return;
        const inArena = !!this.spectatorMode;
        this.ui.showConfirm(
            inArena ? t('dlg.quitArena') : t('dlg.quitNormal'),
            () => inArena ? this.endArenaManually() : this.confirmCancelGame(),
            { title: t('dlg.quitTitle'), confirmLabel: t('dlg.quitConfirm'), cancelLabel: t('dlg.keepPlaying') }
        );
    }

    // Results button: a LIVE snapshot of the standings in the summary layout.
    // Nothing stops — the match and the LLM pipeline keep running.
    //
    // A toggle, like Auto beside it: the same button that opened it closes it. It
    // used to be one-way, with a Back button inside the card doing the returning —
    // two controls for one piece of state, and the way out was somewhere other than
    // the way in.
    toggleArenaSnapshot() {
        if (!this.gameStarted || !this.spectatorMode) return;
        const el = document.getElementById('arenaSummaryScreen');
        if (el && el.classList.contains('snapshot') && el.classList.contains('active')) {
            this.ui.closeArenaSnapshot();
        } else {
            this.ui.resetChartCache();   // rebuild the graph once on entry
            this.ui.showArenaSummary(null, 'snapshot', { snapshot: true });
        }
    }

    confirmCancelGame() {
        // Halt the loop immediately, then do a full, clean reset via reload and
        // route back to the appropriate menu on the next load.
        this.gameStarted = false;
        if (this.ui && this.ui.teardownSpectatorUI) this.ui.teardownSpectatorUI();
        try { sessionStorage.setItem('altertum_return', this.spectatorMode ? 'arena' : 'mode'); } catch (e) {}
        location.reload();
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
    // Starting an arena is a long sequence with exactly one thing catching failures:
    // nothing. showScreen('gameScreen') runs near the top, so the normal PLAYER hud is
    // on screen from that moment, and the two lines that hide it -- along with
    // setupSpectatorUI and the game loop -- are thousands of characters further down.
    // Anything that throws in between leaves a game that is "started", showing the
    // wrong interface, with no loop and no message. And because this is async and the
    // caller does not catch, it is a silent unhandled rejection: from the outside the
    // Start button simply stops working.
    //
    // Reported from a second machine on the LAN, where the library is empty and the
    // origin is not localhost -- both things this box never exercises. Whatever the
    // specific cause turns out to be, a half-started arena that says nothing is its own
    // bug, and it is the reason the report reads "then nothing happens".
    async startArenaFromSetup() {
        try {
            return await this._startArenaFromSetup();
        } catch (e) {
            console.error('[arena] start failed', e);
            this.gameStarted = false;
            this.spectatorMode = false;
            if (this.openAIAIManager && this.openAIAIManager.stop) {
                try { this.openAIAIManager.stop(); } catch (_) {}
            }
            const msg = (e && (e.message || e.toString())) || 'unknown error';
            if (this.ui) {
                this.ui.showArenaSetup();
                if (this.ui.showErrorMessage) this.ui.showErrorMessage(t('ar.startFailed', { msg }));
                else alert(t('ar.startFailed', { msg }));
            }
            return null;
        }
    }

    async _startArenaFromSetup() {
        const setup = this.ui.collectArenaSetup();

        // Validate: every LLM slot must point at a model with an endpoint.
        for (let i = 0; i < setup.length; i++) {
            if (setup[i].type === 'llm' && !(setup[i].connection && setup[i].connection.endpoint)) {
                alert(t('ar.slotNeedsModel', { n: i + 1 }));
                return;
            }
        }

        this.spectatorMode = true;
        // Tempo is per MATCH, not per session. It used to carry over, so a 4x left on
        // from the last run silently applied to the next one — and speed is not a
        // cosmetic preference here: it decides how many turns each seat gets inside the
        // same countdown, which is the thing that decides races. A result whose tempo
        // was inherited from a match the viewer may not even remember starting is a
        // result they cannot read. Same for a pause: a new match must not begin frozen.
        this.setSimSpeed(1);
        this.pauseState = 'running';
        // And the speed-up confirmation is documented as "once per match" — it was
        // stored on the UI and never cleared, so it was really once per session and
        // every match after the first sped up without a word.
        if (this.ui) this.ui._simSpeedWarned = false;
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
                // Frame again now that the real size is known. The fit divides by the
                // aspect, and until this line runs the renderer is still carrying
                // whatever it measured while the game screen was hidden -- the window
                // size if it was lucky, 1280x720 if it was not. Framing twice costs two
                // divisions and no draw: the first keeps the opening frame from being
                // wrong, this one keeps it from staying wrong.
                this.renderer.frameWholeMap();
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
        this.player.seat = 0; // the human always wears team badge 0 (charcoal)
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
        // Blank means "pick one for me", NOT "run unseeded". Terrain falls through to
        // Math.random when seed is null, so a blank field used to produce a layout that
        // could never be played again — and the transcript recorded null, which answered
        // "did you type a seed" rather than "what map was this". Mint one instead: every
        // match is reproducible and every transcript carries the seed that made it.
        this.terrain.seed = (this.ui.setupSeed && this.ui.setupSeed()) || Game.mintSeed();
        this.mapSeed = this.terrain.seed;
        // Stone and gold are laid out ROTATIONALLY around the Town Centers, so the
        // generator needs the spawns before it runs (they are already computed above).
        this.terrain.spawns = spawnPositions;
        this._battles = []; // fresh match, no carried-over engagements
        this.resetTimeline();  // ...and a fresh graph
        this.terrain.generateTerrain();
        this.renderer.setTerrain(this.terrain);

        // Create AI players based on setup
        this.aiManager.aiPlayers = [];
        for (let i = 0; i < numPlayers; i++) {
            const ai = this.aiManager.addAIPlayer(setup[i].civ, 'medium');
            ai.seat = i; // arena slot order → team badge (must be set BEFORE any create*)
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

        // Open on the whole island, square to the screen -- the analyzer's opening shot,
        // and for the same reason. A match nobody has watched yet has no interesting
        // place to point at, so point at all of it.
        //
        // What this replaces was a distance in disguise. camera.position.set() is a
        // compatibility shim that turns the eye's distance from the target into a zoom
        // level, and (0, 205, 265) is 335 away, which lands on a half-height of 101 on a
        // map that runs to 400. So an arena opened on a quarter of the width, centred on
        // the one part of the board where nothing happens at 00:00: both bases start off
        // screen and the viewer's first act is to zoom out and go looking for them. The
        // yaw was left at the play camera's 45 degrees as well, which stands a square map
        // up as a lozenge.
        this.renderer.frameWholeMap();

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
        this.player.seat = 0; // the human always wears team badge 0 (charcoal)

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
        this.terrain.seed = (this.ui.setupSeed && this.ui.setupSeed()) || Game.mintSeed();
        this.mapSeed = this.terrain.seed;
        // Stone and gold are laid out ROTATIONALLY around the Town Centers, so the
        // generator needs the spawns before it runs (they are already computed above).
        this.terrain.spawns = spawnPositions;
        this._battles = []; // fresh match, no carried-over engagements
        this.resetTimeline();  // ...and a fresh graph
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
            // Seat → team badge: campaign opponents start at 1 (the human is 0);
            // the legacy spectator path through here starts at 0. Set BEFORE create*.
            ai.seat = aiStartIndex + i;

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
            // Exactly what the human player does above, and it was missing here. The
            // population field is DERIVED from the unit list rather than incremented, so
            // until something derives it the seat reads as empty. Only the per-tick
            // refresh ever did, which left a window in which three workers were standing
            // on the map under a population of 0 — and every model's opening snapshot
            // fell inside it.
            ai.resources.updatePopulation(ai.units.length);
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
            // No explicit opponent configs (defensive fallback — every live caller
            // passes them): all opponents stay rule-based. The legacy models.json
            // round-robin path that used to live here was unreachable and removed.
            if (this.ui.updateOpponentsPanel) this.ui.updateOpponentsPanel();
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
        this.disableActionCam(); // deliberate focus wins over the auto-director
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
                // Left click: move camera to clicked position (manual input wins
                // over the spectator action camera)
                this.disableActionCam();
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
        this.initBackgroundDriver(); // idempotent; first call spins up the worker
        this.tick();
        requestAnimationFrame(() => this.gameLoop());
    }

    // One logic tick: advance the simulation by the real time elapsed since the
    // previous tick. Driven by requestAnimationFrame while the tab is visible and
    // by the background worker while it is hidden — both paths share
    // lastFrameTime, so interleaved calls simply split the elapsed time between
    // them (no double-simulation possible).
    tick() {
        const currentTime = Date.now();
        let elapsed = currentTime - this.lastFrameTime;
        this.lastFrameTime = currentTime;
        if (!(elapsed > 0)) elapsed = 0;
        // Keep the FULL elapsed time (don't discard like the old 100ms clamp did),
        // but cap a single catch-up so an extreme gap (machine slept) can't freeze
        // the tab replaying it. Fed to the sim in safe ≤100ms slices below.
        const MAX_CATCHUP = 2000; // ms of real time we'll replay in one tick at most
        const simTime = Math.min(elapsed, MAX_CATCHUP);

        // Coarse, once-per-tick work (AI decision cadence and population don't need slicing).
        //
        // Population is derived FIRST, because both managers below read it and one of
        // them ships it to a model. It used to be re-derived at the end of the tick,
        // which meant every state a model received carried the PREVIOUS tick's headcount
        // — harmless while the count held still, a straight contradiction whenever it
        // had just changed, and on the opening turn a population of 0 sitting beside the
        // three workers it was counting. A field that is computed from another field has
        // to be computed before the read, not after it.
        this.aiManager.aiPlayers.forEach(ai => {
            ai.resources.updatePopulation(ai.units.length);
        });
        this.aiManager.update(simTime);
        if (this.openAIAIManager) {
            this.openAIAIManager.update(simTime);
        }
        this.sampleTimeline(currentTime);
        this.pruneBattles();   // time-driven: a quiet map must still let fights expire
        // Keep the selection card current. Health, and anything else it shows, moves
        // while you watch; the card only ever rendered on the click that selected.
        // Throttled to ~400ms: fast enough to watch a building lose health, far
        // cheaper than the per-frame rebuild a tick-rate refresh would be.
        if (currentTime - (this._infoTick || 0) >= 400) {
            this._infoTick = currentTime;
            if (this.ui && this.ui.refreshUnitInfo) this.ui.refreshUnitInfo();
        }

        // Fine simulation in ≤100ms sub-steps so the FULL elapsed time is advanced.
        const STEP_MAX = 100;
        const budgeted = this.simBudget(simTime);
        let remaining = budgeted;
        while (remaining > 0) {
            const step = Math.min(STEP_MAX, remaining);
            this.simulateStep(step);
            remaining -= step;
        }
        this.keepUnitsAshore();

        // HUD/minimap work is pointless while the tab is hidden (background ticks)
        // — skip it. Win conditions ALWAYS run so a match can end unattended.
        const hidden = (typeof document !== 'undefined') && document.hidden;
        if (!hidden) {
            this.updateProgressBar();
            this.ui.updateResources(this.player.resources);
            this.ui.updateAge(this.player.age);
            // Rival intel footer (campaign): epochs are public, counts appear on
            // first contact — refresh every ~2s so both stay current. (No-op in
            // the arena: updateOpponentsPanel hides itself in spectator mode.)
            this._oppPanelTimer = (this._oppPanelTimer || 0) + simTime;
            if (this._oppPanelTimer >= 2000) {
                this._oppPanelTimer = 0;
                if (this.ui.updateOpponentsPanel) this.ui.updateOpponentsPanel();
            }
        }
        // The BUDGET, not raw elapsed time. A Wonder hold is the one clock that could
        // run while the world stood still: it accumulates from whatever it is handed,
        // and handing it real milliseconds meant a paused match could still be won by
        // a Wonder nobody was defending and nobody could attack. (Outside a pause the
        // two are identical whenever it matters — a standing Wonder already forces the
        // sim to 1x — so this changes nothing else.)
        this.checkWinConditions(budgeted);

        // Update minimap periodically (every ~500ms; skipped while hidden)
        if (!hidden) {
            if (!this.minimapUpdateTimer) this.minimapUpdateTimer = 0;
            this.minimapUpdateTimer += simTime;
            if (this.minimapUpdateTimer >= 500) {
                this.minimapUpdateTimer = 0;
                this.updateMinimap();
            }
        }
    }

    // Background-tab driver: browsers pause requestAnimationFrame in hidden tabs
    // and clamp page timers to once a MINUTE after ~5 min (intensive throttling),
    // which used to freeze a running match the moment you switched tabs. Timers
    // inside a dedicated Web Worker are exempt from that clamp, so a tiny inline
    // worker posts a tick every 250ms; we act on it only while the tab is hidden
    // and a match is running. Rendering (the renderer's own rAF loop) stays
    // paused — the SIMULATION and the models' turns keep going. When the tab
    // becomes visible again the pending rAF fires and the normal loop resumes.
    // Limits: a discarded/suspended tab or a sleeping machine still pauses play.
    initBackgroundDriver() {
        if (this._bgDriverTried) return;
        this._bgDriverTried = true;
        try {
            const src = "setInterval(function(){ postMessage(0); }, 250);";
            const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
            this._bgWorker = new Worker(url);
            URL.revokeObjectURL(url);
            this._bgWorker.onmessage = () => {
                if (this.gameStarted && typeof document !== 'undefined' && document.hidden) this.tick();
            };
        } catch (e) {
            // e.g. blocked by CSP — the game still runs, it just pauses when hidden.
            console.warn('[Game] Background driver unavailable (worker blocked):', e);
            this._bgWorker = null;
        }
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
        this.updateHealing(dt);
        this.updateTowerAttack(dt);
        this.updateAutoDefense(dt);
        // Vision
        if (this.fogOfWar) this.fogOfWar.update(dt);
        // Timed progression (research + age-up) — these must advance in step with real
        // time so the leaderboard age never lags behind the actual game.
        this.updateResearchProgress(dt);
        this.updateAgeUpgradeProgress(dt);
        this.sampleJitter(dt);
    }

    // ---- Jitter recorder ------------------------------------------------------
    // A pinned unit vibrates for about five seconds and then frees itself. That is far
    // too short a window to read by hand: asp67 watched one do it twice on an attack
    // into Persia and could not pull the state either time. So the simulation records
    // it instead, and the console reads the recording afterwards -- game.dumpJitter().
    //
    // What it looks for is not "stuck". A pinned unit MOVES; that is the whole problem.
    // It is shoved out of a building ring, walks back in, and is shoved out again, once
    // a frame, covering real distance and arriving nowhere. So the test is path against
    // progress: how far the unit walked in the window, versus how far it actually got.
    // Walking a long way to end up where it started is the signature, and it separates
    // this cleanly from a unit that is merely slow, blocked, or standing still.
    //
    // Sampled rather than per-frame, because a reversal is only meaningful over a
    // distance a single frame cannot cover -- at 60fps the noise is larger than the
    // signal. The expensive part, naming which buildings are pinning it, runs only when
    // an episode is actually recorded, which is rare.
    static get JITTER_SAMPLE_MS() { return 200; }   // one look per window slice
    static get JITTER_WINDOW()    { return 10; }    // slices per verdict (~2s)
    static get JITTER_MIN_PATH()  { return 1.5; }   // walked less than this: not trying
    static get JITTER_RATIO()     { return 0.25; }  // got less than this share of it
    static get JITTER_LOG_MAX()   { return 40; }

    sampleJitter(deltaTime) {
        this._jitterClock = (this._jitterClock || 0) + deltaTime;
        if (this._jitterClock < Game.JITTER_SAMPLE_MS) return;
        this._jitterClock = 0;
        const scan = owner => ((owner && owner.units) || []).forEach(u => {
            if (!u || u.health <= 0 || !u.isMoving) { if (u) u._jPath = 0, u._jN = 0, u._jFrom = null; return; }
            if (!u._jFrom) { u._jFrom = { x: u.x, z: u.z }; u._jLast = { x: u.x, z: u.z }; u._jPath = 0; u._jN = 0; }
            u._jPath += Math.hypot(u.x - u._jLast.x, u.z - u._jLast.z);
            u._jLast = { x: u.x, z: u.z };
            if (++u._jN < Game.JITTER_WINDOW) return;
            const net = Math.hypot(u.x - u._jFrom.x, u.z - u._jFrom.z);
            if (u._jPath >= Game.JITTER_MIN_PATH && net < Game.JITTER_RATIO * u._jPath) {
                this.recordJitter(u, owner, u._jPath, net);
            }
            u._jFrom = { x: u.x, z: u.z }; u._jPath = 0; u._jN = 0;
        });
        scan(this.player);
        ((this.aiManager && this.aiManager.aiPlayers) || []).forEach(scan);
    }

    recordJitter(u, owner, path, net) {
        if (!this._jitterLog) this._jitterLog = [];
        // Which rings it is caught between. Same rule and same numbers clampSlot uses,
        // so a slot this says is illegal is one clampSlot would also have moved.
        const rings = [];
        ((this.getAllBuildings && this.getAllBuildings()) || []).forEach(b => {
            if (!b || b.health <= 0 || b.type === 'farm') return;
            const clr = (b.isWonder ? Game.WONDER_CLEARANCE : Game.UNIT_BUILDING_CLEARANCE) + 0.5;
            const d = Math.hypot(u.x - b.x, u.z - b.z);
            if (d > clr + 3) return;
            rings.push({ type: b.type, x: Math.round(b.x), z: Math.round(b.z),
                         dist: +d.toFixed(2), clearance: clr, inside: d < clr });
        });
        const off = u.formationOffset;
        const slotX = (u.targetX || 0) + (off ? off.x : 0);
        const slotZ = (u.targetZ || 0) + (off ? off.z : 0);
        const legal = this.clampSlot ? this.clampSlot(slotX, slotZ) : { x: slotX, z: slotZ };
        this._jitterLog.push({
            at: new Date().toISOString().slice(11, 19),
            id: u.id, type: u.type, unitType: u.unitType, owner: (owner && owner.id) || '?',
            pos: [+u.x.toFixed(2), +u.z.toFixed(2)],
            target: [+(u.targetX || 0).toFixed(2), +(u.targetZ || 0).toFixed(2)],
            slot: [+slotX.toFixed(2), +slotZ.toFixed(2)],
            // If these differ, the unit is walking at a place it may not stand -- the
            // mover and the renderer's push-out are fighting over it.
            slotLegal: [+legal.x.toFixed(2), +legal.z.toFixed(2)],
            slotIllegalBy: +Math.hypot(legal.x - slotX, legal.z - slotZ).toFixed(2),
            walked: +path.toFixed(2), got: +net.toFixed(2),
            marchSpeed: u.marchSpeed, ownSpeed: u.speed, catchup: u.formationCatchup,
            axis: u.formationAxis ? [+u.formationAxis.x.toFixed(2), +u.formationAxis.z.toFixed(2)] : null,
            attacking: !!u.isAttacking, task: u.task || null, rings
        });
        while (this._jitterLog.length > Game.JITTER_LOG_MAX) this._jitterLog.shift();
    }

    // Console reader. game.dumpJitter() for the table, game.dumpJitter(0, true) for raw.
    dumpJitter(n, raw) {
        const log = this._jitterLog || [];
        if (!log.length) { console.log('[jitter] nothing recorded'); return log; }
        const rows = n ? log.slice(-n) : log;
        if (raw) { console.log(JSON.stringify(rows, null, 2)); return rows; }
        console.table(rows.map(r => ({
            at: r.at, unit: r.type + '#' + r.id, owner: r.owner,
            walked: r.walked, got: r.got, slotIllegalBy: r.slotIllegalBy,
            insideRings: r.rings.filter(x => x.inside).map(x => x.type).join(',') || '-',
            catchup: r.catchup, marchSpeed: r.marchSpeed
        })));
        return rows;
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
            // Priests never take the attack order itself: they tag along to the
            // fight and keep healing wounded friendlies (see updateHealing).
            if (unit.unitType === 'support') {
                unit.isAttacking = false;
                unit.attackTarget = null;
                unit.isMoving = true;
                unit.targetX = target.x + (Math.random() - 0.5) * 4;
                unit.targetZ = target.z + (Math.random() - 0.5) * 4;
                return;
            }
            this.clearRetaliation(unit); // an explicit order overrides the reflex
            unit.isAttacking = true;
            unit.attackTarget = target;
            unit.attackTimer = 0;
            unit.isMoving = true;
            unit.targetX = target.x;
            unit.targetZ = target.z;
        });
    }

    // Priests are pacifist medics. An attack order marches the given support
    // units along as ESCORTS: they move toward the fight (jittered so they
    // don't stack) and heal via updateHealing, but never take a target and
    // never engage. Shared by every attack path — the human right-click escort
    // (inline above), the LLM attack_target/attack-move, and the rule-based
    // army — so priests behave identically no matter who gives the order.
    escortSupportUnits(units, x, z) {
        let n = 0;
        (units || []).forEach(u => {
            if (!u || u.unitType !== 'support' || u.health <= 0) return;
            this.clearRetaliation(u);
            u.isAttacking = false;
            u.attackTarget = null;
            u.attackMove = null;
            u.task = null;
            u.isMoving = true;
            // Formed up with the army when the order carried a shape, scattered around
            // the target when it did not. The random spread was the only behaviour they
            // had, and it undid the formation for exactly the units standing closest to
            // the fighting.
            const off = u.formationOffset;
            u.targetX = x + (off ? off.x : (Math.random() - 0.5) * 4);
            u.targetZ = z + (off ? off.z : (Math.random() - 0.5) * 4);
            n++;
        });
        return n;
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

    // ---- Retaliation focus-fire -------------------------------------------
    // LLM replies take up to ~30s, so ordered armies must defend themselves
    // between turns: when a unit besieging a target takes damage, its whole
    // squad (units on the SAME original target) switches to the damage dealer,
    // kills it, advances to the next attacker in line, and only returns to the
    // original target when none are left. One dealer at a time — a unit never
    // re-switches while its current one lives — so alternating ranged hits
    // can't ping-pong the squad.
    clearRetaliation(unit) {
        if (!unit) return;
        unit._origTarget = null;
        unit._retalQueue = null;
    }

    noteRetaliation(victim, attacker) {
        if (!victim || !victim.unitType || victim.unitType === 'support' || victim.type === 'worker') return;
        if (!victim.isAttacking || !victim.attackTarget) return;
        if (!attacker || attacker.health <= 0) return;
        if (victim.attackTarget === attacker) return; // already fighting back
        if (!victim._origTarget) victim._origTarget = victim.attackTarget;
        victim._retalQueue = victim._retalQueue || [];
        if (!victim._retalQueue.includes(attacker)) victim._retalQueue.push(attacker);
        // Still pounding the original target → take up the FIRST living dealer
        // now and pull the squad along. Already retaliating → it just queues.
        if (victim.attackTarget === victim._origTarget) {
            const first = victim._retalQueue.find(a => a && a.health > 0);
            if (first) {
                victim.attackTarget = first;
                this.spreadRetaliation(victim, first);
            }
        }
    }

    // Focus fire: squadmates on the same original target join in. Units may
    // join from the shared siege target or from a DEAD retaliation target —
    // never off a LIVING one (that would reopen the ping-pong).
    spreadRetaliation(unit, target) {
        const owner = this.getOwner(unit);
        const orig = unit._origTarget;
        if (!owner || !owner.units || !orig) return;
        owner.units.forEach(w => {
            if (w === unit || !w.unitType || w.unitType === 'support' || w.type === 'worker') return;
            if (!w.isAttacking || w.attackTarget === target) return;
            const onOrig = w.attackTarget === orig;
            const onDeadRetal = w._origTarget === orig && w.attackTarget && w.attackTarget.health <= 0;
            if (!onOrig && !onDeadRetal) return;
            w._origTarget = orig;
            w._retalQueue = w._retalQueue || [];
            const qi = w._retalQueue.indexOf(target);
            if (qi > 0) w._retalQueue.splice(qi, 1);
            if (qi !== 0) w._retalQueue.unshift(target); // squad focus = queue head
            w.attackTarget = target;
        });
    }

    // The current dealer fell: next living one in line, else back to the
    // original siege target, else null (the normal nearby scan takes over).
    nextRetaliationTarget(unit) {
        const q = unit._retalQueue;
        if (q) {
            while (q.length) {
                const cand = q[0];
                if (cand && cand.health > 0) {
                    this.spreadRetaliation(unit, cand);
                    return cand;
                }
                q.shift();
            }
        }
        const orig = unit._origTarget;
        this.clearRetaliation(unit);
        return (orig && orig.health > 0) ? orig : null;
    }

    updateCombat(deltaTime) {
        // Iterate a SNAPSHOT: destroyTarget() splices renderer.units mid-loop, and a
        // live-array forEach then skips the unit that slides into the freed index —
        // after every kill one unit silently missed its combat tick. Units that die
        // during this pass are skipped by the health guard instead.
        this.getAllUnits().slice().forEach(unit => {
            if (unit.health <= 0) return;
            // Skip workers - they don't attack unless explicitly ordered
            if (unit.type === 'worker' && !unit.isAttacking) return;

            // Drop a dead/destroyed target — the retaliation ladder decides what
            // comes next: the next living damage dealer in line, then the
            // original siege target, and only then the nearby re-acquire scan.
            if (unit.isAttacking && unit.attackTarget && unit.attackTarget.health <= 0) {
                unit.attackTarget = this.nextRetaliationTarget(unit);
                if (!unit.attackTarget) unit._acquireTimer = 150;
            }

            // Pending retaliation state with no live target (any path that nulled
            // the target) resolves through the ladder before the generic scan.
            if (unit.isAttacking && !unit.attackTarget && (unit._retalQueue || unit._origTarget)) {
                unit.attackTarget = this.nextRetaliationTarget(unit);
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
                    } else if (unit._draftReturn) {
                        // Drafted worker and the area is clear: skip the march to
                        // the rally point — straight back to the economy job.
                        unit.isAttacking = false;
                        this.resumeWorkerAfterCombat(unit);
                        return;
                    } else if (!unit.attackMove) {
                        // Plain attack and nothing nearby (verified by a real scan):
                        // stop instead of chasing far off.
                        unit.isAttacking = false;
                        this.clearRetaliation(unit);
                        this.resumeWorkerAfterCombat(unit); // clears any stale worker combat state
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
                            const moveSpeed = this.moveSpeedOf(unit, deltaTime) * deltaTime / 1000 * 3;
                            unit.x += (dx / dist) * moveSpeed;
                            unit.z += (dz / dist) * moveSpeed;
                            this.renderer.updateUnitPosition(unit);
                        } else {
                            // Reached the objective with nothing left to fight: hold —
                            // except drafted workers, who return to their economy job.
                            unit.isMoving = false;
                            unit.attackMove = null;
                            unit.isAttacking = false;
                            this.clearRetaliation(unit);
                            this.resumeWorkerAfterCombat(unit);
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
                this.clearRetaliation(unit);
                if (!unit.attackMove) unit.isAttacking = false;
            }

            // If unit has an attack target
            if (unit.isAttacking && unit.attackTarget) {
                const currentTarget = unit.attackTarget;
                const dx = currentTarget.x - unit.x;
                const dz = currentTarget.z - unit.z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                
                // Determine attack range (melee = 1.5, ranged = unit.range).
                // For buildings, add a radius so units strike from OUTSIDE the mesh.
                // Wonders are NOT in BUILDING_DEFS (civ-unique buildings) — without
                // the isWonder check they were treated as units, so melee attackers
                // burrowed to 1.5 of the monument's CENTER, deep inside the walls.
                const isBuilding = currentTarget.isWonder || !!(currentTarget.type && BUILDING_DEFS[currentTarget.type]);
                const buildingRadius = isBuilding ? (currentTarget.isWonder ? 4.6 : 3.5) : 0;
                const attackRange = (unit.range > 1 ? unit.range : 1.5) + buildingRadius;
                
                if (dist > attackRange) {
                    // Move towards target — or, while still well short of it, towards
                    // this unit's slot in the marching formation, so an army crosses the
                    // map as a shape instead of as a converging blob. FORM_DROP is where
                    // the shape stops mattering: inside it a unit is closing to fight and
                    // aims at what it is fighting, which is what "march only" means.
                    const FORM_DROP = 12;
                    const off = unit.formationOffset;
                    let ax = currentTarget.x, az = currentTarget.z;
                    if (off && dist > attackRange + FORM_DROP) {
                        // The slot travels with the target, so a fleeing enemy is chased
                        // in formation rather than by a shape aimed at where it used to be.
                        // Clamped to LAND, like a move order's slot: an approach slot in
                        // the water is a unit walking at the sea while keepUnitsAshore
                        // shoves it back, once a tick, for as long as the order stands.
                        const slot = this.clampSlot(currentTarget.x + off.x, currentTarget.z + off.z);
                        const aim = this.formationAim(unit, slot.x, slot.z);
                        ax = aim.x; az = aim.z;
                    } else if (off) {
                        unit.formationOffset = null;   // arrived: ranks dissolve
                        unit.formationAxis = null;
                        unit.formationCatchup = 0;
                    }
                    const adx = ax - unit.x, adz = az - unit.z;
                    const adist = Math.sqrt(adx * adx + adz * adz) || 1;

                    unit.isMoving = true;
                    unit.targetX = currentTarget.x;
                    unit.targetZ = currentTarget.z;

                    const moveSpeed = this.moveSpeedOf(unit, deltaTime) * deltaTime / 1000 * 3;
                    unit.x += (adx / adist) * moveSpeed;
                    unit.z += (adz / adist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                } else {
                    // In range - attack!
                    unit.formationOffset = null;   // fighting now; the march shape is over
                    unit.isMoving = false;
                    unit.attackTimer = (unit.attackTimer || 0) + deltaTime;
                    
                    // Attack every 1 second
                    if (unit.attackTimer >= 1000) {
                        unit.attackTimer = 0;

                        // Deal damage (with rock-paper-scissors counter bonus)
                        const dealt = unit.attack * this.combatMultiplier(unit, currentTarget);
                        currentTarget.health -= dealt;
                        this.recordBattleDamage(unit, currentTarget, dealt);
                        // Remember who hit this target & when, for the auto-defense reflex.
                        currentTarget._lastAttacker = unit;
                        currentTarget._lastDamageTime = Date.now();
                        // A besieging squad answers back: focus-fire the dealer.
                        this.noteRetaliation(currentTarget, unit);

                        // Combat visuals: arrows for ranged shots, a hit flash on the
                        // victim, and a (throttled) battle ping for spectators.
                        if (unit.range > 1) {
                            this.renderer.spawnProjectile(
                                { x: unit.x, y: 1.5, z: unit.z },
                                { x: currentTarget.x, y: 1.1, z: currentTarget.z }, 'arrow');
                        }
                        this.renderer.flashHit(currentTarget);
                        this.notifyCombat(currentTarget.x, currentTarget.z);

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
                            // The killer walks the SAME retaliation ladder as its
                            // squadmates (next dealer → original siege target),
                            // and only then falls back to the re-acquire scan —
                            // otherwise whoever landed the killing blow dropped
                            // out of the ladder and stood down mid-siege.
                            unit.attackTarget = this.nextRetaliationTarget(unit);
                            if (!unit.attackTarget) unit._acquireTimer = 150;
                        }
                    }
                }
            }
        });
    }

    // Support units (priests): pacifist medics. Every army sweep skips them
    // (rule-based, LLM attack actions, auto-defense) — instead they seek the
    // nearest wounded FRIENDLY unit: walk over when idle, then channel a steady
    // heal standing beside it. Explicit move orders are respected — a marching
    // priest heals whatever it happens to pass without stopping, and resumes
    // seeking once idle. Per the unit description they heal OTHER units only —
    // never themselves, never buildings (that's what repair is for).
    updateHealing(deltaTime) {
        const HEAL_SEARCH = 24;  // how far a priest looks for patients
        const HEAL_RANGE  = 3.5; // close enough to channel the heal
        const HEAL_RATE   = 6;   // HP per second
        this.getAllUnits().forEach(u => {
            if (u.unitType !== 'support' || u.health <= 0) return;
            if (u.isAttacking) return; // an explicit attack order wins (safety)

            const owner = this.getOwner(u);
            if (!owner || !owner.units) return;

            let patient = null, best = HEAL_SEARCH;
            owner.units.forEach(o => {
                if (o === u || o.health <= 0 || o.health >= o.maxHealth) return;
                const d = Math.hypot(o.x - u.x, o.z - u.z);
                if (d < best) { best = d; patient = o; }
            });
            if (!patient) return;

            if (best <= HEAL_RANGE) {
                // Priests channel at 80% since the Heilkunde split — the temple
                // tech (bonus.healPower 0.2) buys the last fifth back.
                const healMult = 0.8 + (owner.healPowerBonus || 0);
                const beforeHeal = patient.health;
                patient.health = Math.min(patient.maxHealth,
                    patient.health + (HEAL_RATE * healMult * deltaTime) / 1000);
                // Credit the ACTUAL restore, not the channel rate — the maxHealth
                // clamp truncates the last tick, and a priest should not be reported
                // healing more than it really put back.
                this.recordBattleHealing(u, patient.health - beforeHeal);
                // Soft green sparkle on the patient while the heal channels.
                u._healFxTimer = (u._healFxTimer || 0) + deltaTime;
                if (u._healFxTimer >= 900) {
                    u._healFxTimer = 0;
                    this.renderer.spawnDust(patient.x, 1.2, patient.z, 6, 0x8ef0a8);
                }
            } else if (!u.isMoving) {
                // Idle with someone hurt nearby: walk over (generic mover drives it).
                u.isMoving = true;
                u.targetX = patient.x + (Math.random() - 0.5) * 2;
                u.targetZ = patient.z + (Math.random() - 0.5) * 2;
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
    
    // Tower auto-attack: a finished tower looses a volley at the closest enemies
    // in range, so a tower line is a real deterrent without erasing an army.
    updateTowerAttack(deltaTime) {
        const towers = this.getAllBuildings().filter(b => b.type === 'tower' && !b.underConstruction && b.health > 0);
        const units = this.getAllUnits().slice(); // snapshot: volleys kill mid-loop
        towers.forEach(tower => {
            if (!tower.attackTimer) tower.attackTimer = 0;
            tower.attackTimer += deltaTime;
            if (tower.attackTimer < 1500) return; // fire every 1.5s
            tower.attackTimer = 0;

            const range = tower.range || 6;
            // Volley width and bite both scale with the tower's epoch (TOWER_POWER).
            // tower.age morphs on age-up, so a watchtower raised in the stone age
            // grows into a proper iron fortress on its own.
            const power = towerPower(tower.age);
            const dmg = tower.attack || power.attack;

            // Hit the CLOSEST enemies in range — 2 arrows in the stone age up to 5
            // in iron, so one tower thins a wave instead of erasing it outright.
            const inRange = [];
            units.forEach(unit => {
                if (!unit || unit.owner === tower.owner || unit.health <= 0) return;
                const dx = unit.x - tower.x, dz = unit.z - tower.z;
                const d = Math.sqrt(dx * dx + dz * dz);
                if (d <= range) inRange.push({ unit, d });
            });
            inRange.sort((a, b) => a.d - b.d);
            inRange.slice(0, power.arrows).forEach(({ unit }) => {
                unit.health -= dmg;
                this.recordBattleDamage(tower, unit, dmg);
                // Credit the shooter: the casualty report names the tower, and
                // the auto-defense reflex knows what to retaliate against.
                unit._lastAttacker = tower;
                unit._lastDamageTime = Date.now();
                // Besieging squads turn on the tower shooting them.
                this.noteRetaliation(unit, tower);

                // Combat visuals: a stone from the tower top + flash + battle ping.
                this.renderer.spawnProjectile(
                    { x: tower.x, y: 4.6, z: tower.z },
                    { x: unit.x, y: 1.0, z: unit.z }, 'stone');
                this.renderer.flashHit(unit);
                this.notifyCombat(unit.x, unit.z);

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
            // DAMAGE-triggered, never PROXIMITY-triggered. Do not "improve" this into
            // waking on nearby hostiles; the gap is load-bearing and a model has
            // already stood in it.
            //
            // A 9b model, its army dead and attack_target refusing workers by rule,
            // read the one line in the vocabulary that says move_units accepts
            // {"worker":N} "to place a unit on an exact spot" — and placed
            // ninety-three of them on an enemy Wonder. It could not declare an
            // attack, so it built the conditions for one and waited for somebody
            // else to swing. The defender, Sonnet, read it exactly right from the
            // other side: sixty-six enemy workers in sight, logged as "only enemy
            // workers visible (no threat)", and it waited too — because striking
            // first was the only thing that could turn that crowd into an army.
            // A third player's lone scout hit the Wonder, this draft fired on the
            // damage, and the fight neither of them had chosen began.
            //
            // Waking on proximity would erase both halves at once: no gambit for the
            // attacker, no restraint worth having for the defender. The stand-off is
            // the feature. Confirmed intended by asp67 (2026-07-21) — outplaying the
            // harness is how a small model shows its class, and stays fair game as
            // long as it is not a glitch that makes the game unfair.
            if (!threats.length) return;

            threats.sort((a, b) => this.threatPriority(b.ent) - this.threatPriority(a.ent));
            const primary = threats[0];
            const atk = primary.atk;

            const military = owner.units.filter(u => u.type !== 'worker' && u.unitType !== 'support' && u.health > 0);
            // Idle/free military engage; units already attacking keep their orders.
            //
            // ...and only military within reach of the trouble. This used to be every
            // idle unit on the map, so a scratch on an outlying farm set the whole army
            // walking from wherever it stood — and at speeds of 0.9-2.2 that means
            // singles and pairs arriving across a minute or more, one at a time, into
            // whatever mass did the raiding. Feeding an army piecemeal into a deathball
            // is the worst way to spend it.
            //
            // The radius is tiered by WHAT is being hit, reusing threatPriority (the
            // ladder already exists) and expressed in BATTLE_RADIUS, which is already
            // this game's unit of "at this fight" — one notion of scale, not two:
            //
            //   wonder (3)        no limit. Existential, and the ALL HANDS draft below
            //                     is load-bearing for the stand-off described above.
            //   town_center (2)   2x — the heart of a base; the region answers.
            //   any building (1)  1.5x — a farm or barracks draws its neighbourhood.
            //   a unit (0)        1x — whoever is already standing at that fight.
            //
            // Deliberately NOT a judgement about whether the defence can win: choosing
            // to commit or to write the farm off is the model's call, and the harness
            // does not make it. This only decides who counts as local.
            const REACH = { 3: Infinity, 2: Game.BATTLE_RADIUS * 2,
                            1: Game.BATTLE_RADIUS * 1.5, 0: Game.BATTLE_RADIUS };
            const reach = REACH[this.threatPriority(primary.ent)];
            let defenders = military.filter(u => !u.isAttacking &&
                Math.hypot(u.x - primary.ent.x, u.z - primary.ent.z) <= reach);
            // A WONDER under attack is existential — it IS the win condition — so it
            // is ALL HANDS ON DECK: every worker downs tools and fights ALONGSIDE the
            // army, from anywhere on the map. For anything else workers stay a last
            // resort: only those nearby, and only when there is no army at all.
            const wonderRaid = !!primary.ent.isWonder;
            let hands = [];
            if (wonderRaid || military.length === 0) {
                // Only workers NOT already fighting — this reflex re-runs every ~600ms
                // while the raid lasts, and re-drafting an engaged worker reset its
                // attackTimer below the 1000ms swing threshold FOREVER: drafted mobs
                // surrounded the raider and never landed a single blow until the
                // building fell and the threat list finally emptied. (It also
                // overwrote _draftReturn with the already-drafted state, losing the
                // economy job the worker should return to.)
                hands = owner.units.filter(u => u.type === 'worker' && u.health > 0 &&
                    !u.isAttacking &&
                    (wonderRaid || Math.hypot(u.x - primary.ent.x, u.z - primary.ent.z) <= 28));
                defenders = defenders.concat(hands);
            }
            const usingWorkers = hands.length > 0;

            // Priests march to a DEFENSE exactly as they march to an attack. This was
            // the one order path that never called escortSupportUnits, so the clergy
            // stood at home while the army rode out — the single case that contradicted
            // "they march with an attack and heal wounded units from the back".
            // It sits ABOVE the no-defenders return on purpose: `defenders` holds only
            // units mobilizing THIS tick, so once the army is swinging that list is
            // empty and a priest trained mid-raid would never be sent. Escort whenever
            // a defense exists on site — forming now, or already fighting. No force
            // means no escort: a lone medic walking into a raid is a free kill.
            // Two exclusions, both because this reflex re-runs every ~600ms while the
            // raid lasts: a priest already marching to THIS fight keeps its jittered
            // rally point instead of being handed a new one every tick (the twitch the
            // drafted-worker note above warns about), and a priest tending another live
            // battle is not recalled off an ongoing assault to answer a scratch at home.
            const defenceOnSite = defenders.length > 0 || military.some(u =>
                u.isAttacking && Math.hypot(u.x - atk.x, u.z - atk.z) <= Game.BATTLE_RADIUS);
            if (defenceOnSite) {
                this.escortSupportUnits(owner.units.filter(u =>
                    u.unitType === 'support' && u.health > 0 &&
                    !(u.isMoving && Math.hypot(u.targetX - atk.x, u.targetZ - atk.z) < 12) &&
                    !this.tendingOtherBattle(u, atk)), atk.x, atk.z);
            }

            // Battle report (throttled): the defender learns it is being raided. ABOVE
            // the no-defenders return, and that placement is the whole point.
            //
            // "battles" cannot carry this. A player appears in an engagement only via
            // b.sides[id], and a side is created for the ATTACKER when it deals damage,
            // or for whoever LOSES a unit or building. Take fire, lose nothing, send
            // nobody, and you have no side — the raid is absent from your battles list
            // altogether. So with the radius above, the case this reflex now declines to
            // answer would have become the case nobody tells you about, which is exactly
            // backwards: an unanswered raid is MORE worth reporting than an answered one,
            // because only the model can decide what to do about it.
            //
            // Volume is unchanged: the 10s throttle already caps this at one line per
            // owner, and the 14-slot events buffer is why unit deaths were moved out of
            // prose into the battle ledger in the first place (see destroyUnit) —
            // specifically to stop them evicting THESE warnings.
            if (!owner._lastRaidEventAt || now - owner._lastRaidEventAt > 10000) {
                owner._lastRaidEventAt = now;
                const entLabel = primary.ent.isWonder ? 'WONDER' : (primary.ent.type || primary.ent.unitType || 'unit');
                const draftNote = !usingWorkers ? ''
                    : (wonderRaid ? ' — ALL HANDS: every worker downed tools to defend it'
                                  : ' — workers drafted to defend');
                // Say so when nothing is coming, rather than leaving it to be inferred
                // from an absence: this is the line that tells a model its army is out
                // of position while its base is being taken apart.
                const noneNote = defenders.length ? '' : ' — no defenders in range';
                this.logPlayerEvent(owner,
                    `UNDER ATTACK: your ${entLabel} at (${Math.round(primary.ent.x)}, ${Math.round(primary.ent.z)}) is taking damage from ${this.ownerName(this.getOwner(atk))}${draftNote}${noneNote}`);
            }

            if (!defenders.length) return;

            // defenders can MIX military and drafted workers now (a wonder raid pulls
            // both), so the economy bookkeeping is per unit, not per batch.
            defenders.forEach(d => {
                if (d.type === 'worker') {
                    // Remember the economy job so the worker RETURNS to it after
                    // the fight (resumeWorkerAfterCombat) instead of idling in a
                    // tangled pile at the battle site.
                    d._draftReturn = { task: d.task, harvestTarget: d.harvestTarget || null, farmRef: d.farmRef || null };
                    if (d.farmRef && d.farmRef.assignedWorker === d) d.farmRef.assignedWorker = null;
                    d.farmRef = null;
                    d.isHarvesting = false;
                    d.carryingResource = false;
                }
                d.task = null;
                this.clearRetaliation(d); // fresh draft, fresh focus
                d.isAttacking = true;
                d.attackTarget = atk;
                // Small spread on the rally point so a worker mob doesn't try to
                // occupy one exact spot when the fight ends (the old jam).
                d.attackMove = { x: atk.x + (Math.random() - 0.5) * 5, z: atk.z + (Math.random() - 0.5) * 5 };
                d.attackTimer = 0;
                d.isMoving = true;
                d.targetX = atk.x;
                d.targetZ = atk.z;
            });
        });
    }

    // Is this unit already tending a live engagement somewhere OTHER than the one at
    // (atk)? Reuses the battle ledger so auto-defense can tell "idle at home" from
    // "healing at the front" without inventing a second piece of bookkeeping.
    tendingOtherBattle(unit, atk) {
        const now = Date.now();
        return (this._battles || []).some(b =>
            (now - b.lastAt) < Game.BATTLE_QUIET_MS &&
            Math.hypot(b.x - atk.x, b.z - atk.z) > Game.BATTLE_RADIUS &&
            Math.hypot(unit.x - b.x, unit.z - b.z) <= Game.BATTLE_RADIUS);
    }

    // A worker's fight is over: send it back to the economy job it was drafted
    // from (or the nearest surviving node of that type). Also clears combat
    // state for non-drafted workers so none is left half-fighting, half-gathering.
    resumeWorkerAfterCombat(unit) {
        if (unit.type !== 'worker') return;
        const r = unit._draftReturn;
        unit._draftReturn = null;
        unit.attackMove = null;
        unit.isAttacking = false;
        unit.attackTarget = null;
        if (!r) return;
        if (r.farmRef && r.farmRef.health > 0 && !r.farmRef.assignedWorker) {
            unit.task = 'farm_work';
            unit.farmRef = r.farmRef;
            r.farmRef.assignedWorker = unit;
            unit.isMoving = true;
            unit.targetX = r.farmRef.x + (Math.random() - 0.5) * 3;
            unit.targetZ = r.farmRef.z + (Math.random() - 0.5) * 3;
            return;
        }
        if (r.harvestTarget && r.harvestTarget.amount > 0) {
            unit.task = 'harvesting';
            unit.harvestTarget = r.harvestTarget;
            unit.isHarvesting = false;
            unit.harvestTimer = 0;
            unit.isMoving = true;
            unit.targetX = r.harvestTarget.x + (Math.random() - 0.5) * 2;
            unit.targetZ = r.harvestTarget.z + (Math.random() - 0.5) * 2;
            return;
        }
        if (r.harvestTarget) {
            // The node ran dry during the fight: nearest discovered same-type node.
            unit.harvestTarget = r.harvestTarget;
            this.retargetDepletedWorker(unit, this.getOwner(unit));
        }
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
    // Called whenever damage lands. Purely presentational: spawns a throttled
    // battle ring in the world (max one per ~35-unit area / 5s), queues a minimap
    // ping, and records the event for the spectator action camera. No game effect.
    notifyCombat(x, z) {
        const now = Date.now();
        // World ring — throttled per coarse map cell so a melee doesn't strobe.
        this._pingCells = this._pingCells || {};
        const key = Math.round(x / 35) + ':' + Math.round(z / 35);
        if (!this._pingCells[key] || now - this._pingCells[key] > 5000) {
            this._pingCells[key] = now;
            this.renderer.spawnBattleRing(x, z);
        }
        // Minimap ping (drawn by updateMinimap, expires after 4s).
        this._combatPings = this._combatPings || [];
        this._combatPings.push({ x, z, until: now + 4000 });
        if (this._combatPings.length > 30) this._combatPings.shift();
        // Feed for the spectator action camera. THROTTLED PER CELL, like the battle
        // ring above it and for a sharper reason: every damage tick was pushed, so a
        // twenty-unit melee filled a 120-entry buffer in about a second and evicted
        // every other fight on the map. A second battle then did not exist as far as
        // the camera was concerned -- and "cut between two brawls" failed exactly when
        // one of them was big, which is when it matters. Found by staging two fights
        // and watching the director report one.
        //
        // One event per 25-unit cell per 350ms. That also makes the count a better
        // measure of a fight than raw ticks were: it now counts how much GROUND is
        // being fought over and for how long, instead of how many swings landed, so a
        // dense scrum no longer outranks a wide assault simply by hitting more often.
        this._combatEvents = this._combatEvents || [];
        this._camCells = this._camCells || {};
        const ck = Math.round(x / 25) + ':' + Math.round(z / 25);
        if (!this._camCells[ck] || now - this._camCells[ck] > 350) {
            this._camCells[ck] = now;
            this._combatEvents.push({ x, z, t: now });
            // Age, not count, is what the director reads (it filters to the last 6s);
            // the cap is only a backstop against a match nobody is watching.
            if (this._combatEvents.length > 400) this._combatEvents.shift();
        }
    }

    // Spectator action camera: toggled from the status bar. When on, the renderer
    // eases the camera toward the hottest recent fight and drifts gently when the
    // map is quiet. Any manual camera action switches it off — the user always wins.
    // Whatever the spectator currently has selected, as a camera subject — or null.
    // Derived from the selection rather than remembered separately: the selection is
    // what "the thing I am watching" means, and a second copy of that fact is how the
    // info card ended up showing one unit while the camera followed something else.
    _selectionAsCamSubject() {
        if (this.selectedBuilding && this.selectedBuilding.health > 0) {
            return { kind: 'ent', ent: this.selectedBuilding };
        }
        for (const ai of this.aiManager.aiPlayers) {
            const u = ai.units.find(x => x.selected && x.health > 0);
            if (u) return { kind: 'units', units: [u] };
        }
        return null;
    }

    // How much simulation the clock may advance right now. Both gates live here
    // rather than at the tick's source, so anything driving the sub-step loop obeys
    // both of them.
    //
    // SPEED multiplies game time against wall time. It is forced back to 1x while any
    // Wonder stands, and the reason is subtler than it looks: the hold is accumulated
    // from deltaTime, so it scales WITH the sim and the march-versus-wonder race is
    // preserved. What does not scale is a model's thinking time — at 2x a slow seat
    // gets half the decisions inside the same countdown. The decision budget is what
    // decides that race, so it is the thing to protect.
    //
    // TURN-BASED does not touch this. The match keeps running at the chosen speed while
    // seats think; fairness there comes from every seat reading the same snapshot and
    // every move landing at the same instant (see OpenAIAIManager.flushRound), not from
    // holding the world still.
    // Short, readable, and unmistakably machine-picked so nobody wonders whether they
    // typed it. Any string works — terrain hashes it — so this only has to be unique
    // enough that two matches minutes apart do not collide.
    static mintSeed() {
        return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    simBudget(ms) {
        if (this.pauseState === 'paused') return 0;
        return ms * (this.anyWonderStanding() ? 1 : (this.simSpeed || 1));
    }

    // Pause takes effect only once nothing is in flight; the AI manager makes that call
    // (it is the only thing that knows) and flips us to 'paused'.
    requestPause() {
        if (this.pauseState === 'running') this.pauseState = 'pausing';
        if (this.ui && this.ui.updateSimSpeedButton) this.ui.updateSimSpeedButton();
    }
    resumeSim() {
        this.pauseState = 'running';
        // Elapsed time is measured from lastFrameTime, which has been advancing all
        // through the pause. Without this the first tick back would hand the sim the
        // entire pause as one catch-up and the match would jump.
        this.lastFrameTime = Date.now();
        if (this.ui && this.ui.updateSimSpeedButton) this.ui.updateSimSpeedButton();
    }
    isPaused() { return this.pauseState === 'paused'; }

    // Any Wonder on the map at all, finished or still going up — a rival can already
    // be marching at one that is half-built, so the race starts before it completes.
    anyWonderStanding() {
        const list = (this.renderer && this.renderer.buildings) || [];
        for (const b of list) if (b.isWonder && b.health > 0) return true;
        return false;
    }

    // 1 | 1.5 | 2 | 4. Returns what actually took effect, which is 1 while a Wonder stands.
    setSimSpeed(mult) {
        this.simSpeed = [1, 1.5, 2, 4].includes(mult) ? mult : 1;
        if (this.ui && this.ui.updateSimSpeedButton) this.ui.updateSimSpeedButton();
        return this.effectiveSimSpeed();
    }

    effectiveSimSpeed() { return this.anyWonderStanding() ? 1 : (this.simSpeed || 1); }

    toggleActionCam() {
        this._actionCam = !this._actionCam;
        // A fresh start each time it is switched on: shot history, per-player
        // airtime and the anti-repeat window all describe a viewing session, and
        // carrying them across a manual takeover would make the first shot back
        // an argument with a session nobody was watching.
        if (this._director) this._director.reset();
        // Switching it ON adopts whatever is already selected. "Follow the selected
        // unit" has to mean the same thing whichever order you do it in, and this
        // used to clear the subject unconditionally — so picking a unit and THEN
        // pressing Auto silently started a tour instead, while the unit stayed
        // selected and its card stayed on screen. Only the other order worked.
        this._camFollow = this._actionCam ? this._selectionAsCamSubject() : null;
        const btn = document.getElementById('actionCamBtn');
        if (btn) btn.classList.toggle('sb-on', this._actionCam);
    }

    disableActionCam() {
        if (this._actionCam) this.toggleActionCam();
    }

    // The director's shot for this frame: { x, z, yaw, pitch, halfH, cut }.
    //
    // What stood here returned { x, z, zoom } and the renderer eased toward it
    // every frame. No yaw and no pitch meant the angle never changed in a whole
    // match, and easing toward the newest point meant every change of subject was
    // a PAN -- seconds of empty grass at constant speed between the things worth
    // watching. Both are properties of the SHAPE of the answer, which is why this
    // moved to js/director.js and started answering with shots instead: a subject,
    // a pose, a motion and a duration, cut between and moved within.
    //
    // The helpers stayed here (_resolveCamSubject, _subjectZoom,
    // _biggestArmyCluster). They answer "where is this subject", which is a
    // question about the game, not about the camera, and the director calls them.
    directorPose() {
        if (this._dirDebug === undefined) {
            this._dirDebug = /[?&]dir=1(&|$)/.test(location.search);
        }
        if (!this._director) this._director = new Director(this);
        const now = Date.now();
        const pose = this._director.update(now);
        if (this._dirDebug) this._director.renderDebug(now);
        return pose;
    }

    // Desired camera half-height for a director/follow subject: tight on a lone
    // unit, framed to the bounding radius of a group, medium on a building.
    _subjectZoom(subject) {
        if (!subject) return 34;
        if (subject.kind === 'ent') return (subject.ent && subject.ent.isWonder) ? 44 : 30;
        const live = (subject.units || []).filter(u => u.health > 0);
        if (live.length <= 1) return 17; // a single followed unit → close-up
        const cx = live.reduce((a, u) => a + u.x, 0) / live.length;
        const cz = live.reduce((a, u) => a + u.z, 0) / live.length;
        let r = 0;
        live.forEach(u => { r = Math.max(r, Math.hypot(u.x - cx, u.z - cz)); });
        return Math.max(22, Math.min(60, r * 1.5 + 14));
    }

    // Spectator click-to-inspect: pick the entity whose on-screen dot is
    // nearest the click (units win ties inside a building footprint), show its
    // stat card, and — when the action cam is on — follow it. Empty ground
    // clears the selection. Mirrors a player match's select-to-inspect.
    spectatorPick(clientX, clientY) {
        // Not on the analyzer screen. anMountStage turns spectatorMode ON so the replay
        // inherits the full spectator camera — which also arms the renderer's
        // click-to-inspect (it calls this whenever spectatorMode is set and the pointer
        // did not move). That ran on every click in the replay, AFTER the analyzer's own
        // capture-phase pick, and did two wrong things at once:
        //
        //   _clearSpectatorSelection() wiped the flag the analyzer had just set, without
        //   clearing renderer.selectedUnits — so the state read as one unit selected and
        //   no unit flagged, which is not a state selectUnit can produce;
        //
        //   and then it looked for a replacement among aiManager.aiPlayers, where a
        //   replay's entities do not live. They exist only in renderer.units. So it found
        //   nothing, cleared the selection and returned.
        //
        // The stat card survived because it is DOM, which is exactly why this presented
        // as a rendering fault and cost three rounds of ring size and ring colour work
        // before anyone looked at the flag.
        //
        // Same delegation rule as discoveryAt: on that screen the analyzer owns picking,
        // through anPickAt.
        const anScreen = document.getElementById('analyzeScreen');
        if (anScreen && anScreen.classList.contains('active')) return;
        const rnd = this.renderer;
        if (!rnd || !rnd.worldToScreen || !rnd.canvas) return;
        const rect = rnd.canvas.getBoundingClientRect();
        const px = clientX - rect.left, py = clientY - rect.top;
        let best = null, bestIsUnit = false, bestScore = Infinity;
        const consider = (ent, isUnit, anchorY, radius) => {
            if (!ent || ent.health <= 0) return;
            const s = rnd.worldToScreen(ent.x, anchorY, ent.z);
            if (!s) return;
            const d = Math.hypot(s.x - px, s.y - py);
            if (d > radius) return;
            const score = d - (isUnit ? 8 : 0); // a unit standing on a building wins
            if (score < bestScore) { bestScore = score; best = ent; bestIsUnit = isUnit; }
        };
        this.aiManager.aiPlayers.forEach(o => {
            // Anchor buildings at the GROUND BASE (y≈0), not the elevated centre:
            // in the isometric view the base is where a human instinctively
            // clicks, and the mesh centre projects well above it. Generous radius
            // since footprints are large.
            o.buildings.forEach(b => consider(b, false, 0.5, 60));
            o.units.forEach(u => consider(u, true, 1.2, 26));
        });
        this._clearSpectatorSelection();
        if (!best) {
            this._camFollow = null;
            this.ui.updateUnitInfo(null, null);
            return;
        }
        if (bestIsUnit) {
            best.selected = true;
            this.ui.updateUnitInfo(best, null);
            this._camFollow = { kind: 'units', units: [best] };
        } else {
            this.selectedBuilding = best;
            this.ui.updateUnitInfo(null, best);
            this._camFollow = { kind: 'ent', ent: best };
        }
    }

    _clearSpectatorSelection() {
        this.getAllUnits().forEach(u => { if (u.selected) u.selected = false; });
        this.selectedBuilding = null;
    }

    // The most watch-worthy thing a player owns right now.
    _pickCamSubject(ai) {
        const wonder = ai.buildings.find(b => b.isWonder && b.health > 0);
        if (wonder) return { kind: 'ent', ent: wonder };
        const cluster = this._biggestArmyCluster(ai);
        if (cluster) return { kind: 'units', units: cluster };
        const site = [...ai.buildings].reverse().find(b => b.underConstruction && b.health > 0);
        if (site) return { kind: 'ent', ent: site };
        const tc = ai.buildings.find(b => b.type === 'town_center' && b.health > 0);
        if (tc) return { kind: 'ent', ent: tc };
        if (ai.buildings.length) return { kind: 'ent', ent: ai.buildings[0] };
        if (ai.units.length) return { kind: 'units', units: [ai.units[0]] };
        return null;
    }

    // Densest 40x40 cell of a player's military — "the army", camped or marching.
    _biggestArmyCluster(ai) {
        const mil = ai.units.filter(u => u.type !== 'worker' && u.health > 0);
        if (mil.length < 2) return null;
        const cells = new Map();
        mil.forEach(u => {
            const key = Math.round(u.x / 40) + ':' + Math.round(u.z / 40);
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(u);
        });
        let best = null;
        cells.forEach(list => { if (!best || list.length > best.length) best = list; });
        return best;
    }

    // Live position of a tour subject; null once it died/finished (advance tour).
    _resolveCamSubject(subject) {
        if (!subject) return null;
        if (subject.kind === 'ent') {
            const e = subject.ent;
            return (e && e.health > 0) ? { x: e.x, z: e.z } : null;
        }
        const live = (subject.units || []).filter(u => u.health > 0);
        if (!live.length) return null;
        return {
            x: live.reduce((a, u) => a + u.x, 0) / live.length,
            z: live.reduce((a, u) => a + u.z, 0) / live.length
        };
    }

    // ---- Battle ledger -------------------------------------------------------
    // A model never watches a fight: the state is a snapshot and the shooting
    // happens while it is thinking. Damage, healing and losses accumulate into
    // location-clustered ENGAGEMENTS, serialized per player as "battles".
    //
    // CUMULATIVE per engagement, not per turn. A fight outlasts several turns
    // (a 5v5 runs 20-40s, a turn is 5-20s), and with the history compressed a
    // model cannot re-assemble per-turn fragments — it would only ever see
    // splinters of a battle it is trying to decide about.
    //
    // This also replaces the per-unit LOSS/KILL prose: two events per death
    // flooded the 14-slot recentEvents buffer in any real battle and evicted the
    // UNDER ATTACK warnings along with everything else.
    // Radius that counts as ONE fight. Sized off the map, not guessed: a base rings
    // its Town Center at 18-46 units (executeBuildStructure) so opposite corners of
    // one village sit ~92 apart, and a Wonder reaches 90 on its own. A tighter
    // radius shatters a single city assault — squads spread across the village
    // razing different buildings — into several unreadable "battles". Rival bases
    // spawn 400+ apart, so 90 unifies one siege while never merging two of them.
    static get BATTLE_RADIUS() { return 90; }
    static get BATTLE_QUIET_MS() { return 10000; }   // no blows for this long → the fight is over
    // ...but keep reporting it long after. A slow model can spend 20-30s on a turn,
    // so a short window meant the only record of a fight could expire between the
    // last blow and that player's next look at the board.
    static get BATTLE_KEEP_MS() { return 120000; }
    // Engagements held at once, across every player. Sized against KEEP_MS: entries
    // now linger nearly 5x longer, so the old cap of 4 would have run out of room in
    // any busy match and started dropping live fights to make space.
    static get BATTLE_MAX() { return 8; }

    _battleAt(x, z, open) {
        const now = Date.now();
        const R = Game.BATTLE_RADIUS;
        this.pruneBattles();
        const near = this._battles.filter(e =>
            (now - e.lastAt) <= Game.BATTLE_QUIET_MS && Math.hypot(e.x - x, e.z - z) <= R);
        let b = near[0] || null;
        // Two fronts that grow together are ONE battle — models routinely split an
        // army across a village and then regroup on one spot, and separate buckets
        // would keep reporting halves of a fight that has become a single mass.
        for (let i = 1; i < near.length; i++) {
            this._mergeBattleInto(b, near[i]);
            const idx = this._battles.indexOf(near[i]);
            if (idx >= 0) this._battles.splice(idx, 1);
        }
        if (!b && open) {
            b = { x, z, startedAt: now, lastAt: now, sides: {} };
            this._battles.push(b);
            // Evict the STALEST, not the earliest inserted. At a two-minute window a
            // long siege is easily the oldest entry while still being the live one,
            // and shift() would have dropped it to make room for a fresh skirmish.
            while (this._battles.length > Game.BATTLE_MAX) {
                let stalest = 0;
                for (let i = 1; i < this._battles.length; i++) {
                    if (this._battles[i].lastAt < this._battles[stalest].lastAt) stalest = i;
                }
                this._battles.splice(stalest, 1);
            }
        }
        return b || null;
    }

    // Retire engagements nobody has touched in a while — kept well past the last
    // blow so a slow model still gets a turn to read how the fight ended.
    //
    // TIME-driven, and that is the point: this used to live inside _battleAt, which
    // only runs when a blow lands. So the moment the map went quiet — exactly when a
    // battle has just finished — nothing pruned, and the last entries rode along in
    // every state for the rest of the match. The one caller that reads _battles
    // outside combat (the state serializer) never filtered by age either.
    pruneBattles() {
        const now = Date.now();
        this._battles = (this._battles || []).filter(b => (now - b.lastAt) <= Game.BATTLE_KEEP_MS);
    }

    _mergeBattleInto(dst, src) {
        if (!dst || !src || dst === src) return;
        dst.startedAt = Math.min(dst.startedAt, src.startedAt);
        dst.lastAt = Math.max(dst.lastAt, src.lastAt);
        Object.entries(src.sides).forEach(([ownerId, s]) => {
            const d = dst.sides[ownerId] || (dst.sides[ownerId] = { involved: {}, lost: {} });
            Object.entries(s.involved).forEach(([type, e]) => {
                const t = d.involved[type] ||
                    (d.involved[type] = { ids: new Set(), dmgUnits: 0, dmgBuildings: 0, healed: 0 });
                e.ids.forEach(id => t.ids.add(id));
                t.dmgUnits += e.dmgUnits; t.dmgBuildings += e.dmgBuildings; t.healed += e.healed;
            });
            Object.entries(s.lost).forEach(([type, n]) => { d.lost[type] = (d.lost[type] || 0) + n; });
        });
    }

    _battleEntry(battle, ownerId, type) {
        const side = battle.sides[ownerId] || (battle.sides[ownerId] = { involved: {}, lost: {} });
        return side.involved[type] ||
            (side.involved[type] = { ids: new Set(), dmgUnits: 0, dmgBuildings: 0, healed: 0 });
    }

    // Damage OPENS an engagement — it is what a battle is made of. Attributed by
    // the attacker's own type, so towers and drafted workers show up as themselves.
    recordBattleDamage(attacker, target, amount) {
        if (!attacker || !target || !(amount > 0) || attacker.owner == null) return;
        const b = this._battleAt(target.x, target.z, true);
        if (!b) return;
        const e = this._battleEntry(b, attacker.owner, attacker.type);
        e.ids.add(attacker.id);
        // Razing a building is not the same achievement as killing an army, so the
        // two are never summed — infantry hit buildings at 1.5x and ranged at 0.5x,
        // which would make a siege look like a won field battle.
        const isBuilding = target.isWonder || !!(target.type && BUILDING_DEFS[target.type]);
        if (isBuilding) e.dmgBuildings += amount; else e.dmgUnits += amount;
        b.lastAt = Date.now();
        // Drift toward where the blows land so a rolling fight stays ONE engagement.
        b.x += (target.x - b.x) * 0.05;
        b.z += (target.z - b.z) * 0.05;
    }

    // Healing only JOINS a fight, never opens one — otherwise priests topping units
    // up between battles would spawn phantom engagements across the map.
    recordBattleHealing(healer, amount) {
        if (!healer || !(amount > 0) || healer.owner == null) return;
        const b = this._battleAt(healer.x, healer.z, false);
        if (!b) return;
        const e = this._battleEntry(b, healer.owner, healer.type);
        e.ids.add(healer.id);
        e.healed += amount;
    }

    recordBattleLoss(victim) {
        if (!victim || victim.owner == null) return;
        const b = this._battleAt(victim.x, victim.z, false);
        if (!b) return;
        const side = b.sides[victim.owner] || (b.sides[victim.owner] = { involved: {}, lost: {} });
        side.lost[victim.type] = (side.lost[victim.type] || 0) + 1;
    }

    // Rolling per-player battle report. Serialized into the LLM game state as
    // "recentEvents" so a model learns about losses, kills and raids it can't
    // otherwise see (the state is a snapshot; deaths between turns were silent).
    // `ttl` is how many state builds the entry survives, defaulting to the 2 that
    // everything here has always used. A CONTACT passes 1: it is a sighting at a
    // moment, and a moment restated next turn reads as a second sighting -- the model
    // would see one scout twice and count two. What it saw stays in its own history,
    // which is where "where have they been roaming" is actually answered.
    logPlayerEvent(ownerObj, text, ttl) {
        if (!ownerObj) return;
        ownerObj.events = ownerObj.events || [];
        // "seq" is the state-build counter this event was logged under, and it is what
        // expires the event later. Wall-clock cannot do that job: turns are seconds
        // apart at 1x, a quarter of that at 4x, and a minute apart for a slow model, so
        // any fixed number of seconds means something different for every player in the
        // same match. A turn count means the same thing for all of them.
        ownerObj.events.push({ at: Date.now(), seq: ownerObj._turnSeq || 0, text,
                               ttl: (typeof ttl === 'number' && ttl > 0) ? ttl : 2 });
        if (ownerObj.events.length > 14) ownerObj.events.shift();
    }

    // A durable record of buildings a player has lost, read back for the same window
    // the battle ledger uses.
    //
    // The prose LOSS line above already says it — but into recentEvents, which expires
    // by DISPLACEMENT, not time: 14 slots, of which the model is shown 8, and busiest
    // precisely while things are being destroyed. So the notice was routinely evicted
    // before the owner's next turn, and a building simply vanished from
    // friendlyBuildings with nothing left pointing at it. Unit deaths were moved out of
    // that buffer into the battle ledger for exactly this reason; buildings were left
    // behind. The battle ledger does count them, but as a bare type tally inside an
    // engagement — and only when one was already open near the spot, since
    // recordBattleLoss will not start one.
    noteBuildingLoss(ownerObj, building, killerOwner) {
        if (!ownerObj || !building) return;
        const list = ownerObj._lostBuildings || (ownerObj._lostBuildings = []);
        list.push({
            at: Date.now(),
            type: building.type,
            wonder: !!building.isWonder,
            x: Math.round(building.x),
            z: Math.round(building.z),
            to: (killerOwner && killerOwner !== ownerObj) ? this.ownerName(killerOwner) : null
        });
        // Bound the array; the AGE rule lives at the read side so a quiet map cannot
        // leave a stale entry sitting in the state (the mistake the battle ledger made).
        if (list.length > 25) list.splice(0, list.length - 25);
    }

    // How a player is REFERRED TO in anything a model reads: battles, UNDER ATTACK
    // and LOSS/KILL events, recentLosses.to, the Wonder countdown.
    //
    // This used to answer with the civilization, which is exactly wrong for the
    // benchmark case: a controlled run gives all four seats the SAME civ, so three
    // different rivals all came back "greek" and no report could be attributed to
    // anyone. The seat id is the key the model already holds — gameStats.opponents[].id,
    // enemyBuildings[].owner, enemyUnits[].owner — so naming seats by it is what makes
    // "who is hitting me" joinable with "who is where". The civ is still one lookup
    // away in gameStats.opponents.
    ownerName(o) { return this.seatLabel(o); }

    // The ONE name a rival has in everything a model reads, and the only thing that
    // changed: ai.id is untouched, every `entity.owner === ai.id` still compares raw
    // ids, and nothing about identity moved. This is a label applied at the boundary.
    //
    // "ai_3naqjagyz" was chosen for a real reason -- a controlled run gives all four
    // seats the SAME civ, so "greek" named three rivals at once and no battle report
    // could be attributed. The id fixed that and cost readability: a closing statement
    // about ai_3naqjagyz means nothing to anyone watching. civ + seat keeps the
    // property that mattered (greek-1 .. greek-4 are still four distinct rivals) and
    // reads as words.
    //
    // Takes an owner OBJECT or a raw id string, because half the call sites hold one
    // and half hold the other. Unresolvable ids fall through unchanged rather than
    // becoming "an enemy" -- losing information is worse than an ugly token.
    //
    // NOT the model's display name. That is the most readable option and it would tell
    // every seat which models it is playing against, which is a change to what the
    // benchmark measures rather than a change to how it reads.
    seatLabel(o) {
        if (!o) return 'an unknown force';
        if (o === this.player || o === 'player') return 'player';
        const list = (this.aiManager && this.aiManager.aiPlayers) || [];
        const ai = (typeof o === 'string') ? list.find(a => a.id === o) : o;
        if (!ai) return typeof o === 'string' ? o : 'an enemy';
        const seat = (ai.seat != null) ? ai.seat + 1 : (list.indexOf(ai) + 1);
        return `${ai.civilization || 'seat'}-${seat > 0 ? seat : '?'}`;
    }

    destroyTarget(target) {
        // isWonder: civ-unique buildings (pyramid/firetemple/…) are NOT in
        // BUILDING_DEFS — without this a razed Wonder took the UNIT removal path,
        // stayed in its owner's buildings list forever and blocked them from ever
        // building another Wonder ("already building or holding a Wonder").
        const isBuilding = target.isWonder || (target.type && BUILDING_DEFS[target.type]);

        // Battle report for both sides, before any list surgery. Specific types
        // on BOTH ends ("your warrior was eliminated by X's tower"), so a model
        // reads exactly what it lost and what killed it — workers, military and
        // buildings alike all die through here.
        const victimOwner = isBuilding ? this.getOwnerByBuilding(target) : this.getOwner(target);
        const killerOwner = target._lastAttacker ? this.getOwner(target._lastAttacker) : null;
        const at = `(${Math.round(target.x)}, ${Math.round(target.z)})`;
        const label = isBuilding ? (target.isWonder ? 'Wonder' : target.type) : target.type;
        const killer = target._lastAttacker;
        const killerLabel = killer ? (killer.isWonder ? 'Wonder' : killer.type) : null;
        // Unit casualties go to the battle ledger (aggregated per engagement, for
        // BOTH sides). They used to be two prose events per death, which flooded the
        // 14-slot recentEvents buffer in any real fight and evicted the UNDER ATTACK
        // warnings with it. BUILDINGS still get prose: losing one is rare, singular
        // and strategically distinct, so it deserves to be said out loud.
        if (target.isWonder) this.noteWonder(target, 'lost');
        this.recordBattleLoss(target);
        if (isBuilding) {
            if (victimOwner) {
                const by = (killerOwner && killerOwner !== victimOwner)
                    ? ` by ${this.ownerName(killerOwner)}'s ${killerLabel || 'forces'}` : '';
                this.logPlayerEvent(victimOwner, `LOSS: your ${label} was destroyed${by} at ${at}`);
                this.noteBuildingLoss(victimOwner, target, killerOwner);
            }
            if (killerOwner && killerOwner !== victimOwner) {
                this.logPlayerEvent(killerOwner, `KILL: your ${killerLabel || 'forces'} destroyed ${this.ownerName(victimOwner)}'s ${label} at ${at}`);
            }
        }

        // (The population cap is re-derived AFTER the list surgery below, once
        // this building is really gone — see recomputeMaxPopulation.)

        if (isBuilding) {
            if (target.owner === 'player') {
                this.removeBuilding(target);
            } else {
                // AI building
                const ai = this.aiManager.aiPlayers.find(a => a.buildings.includes(target));
                if (ai) {
                    const idx = ai.buildings.indexOf(target);
                    if (idx > -1) ai.buildings.splice(idx, 1);
                }
                this.renderer.killBuilding(target); // crumble + dust instead of popping away
            }
        } else {
            if (target.owner === 'player') {
                this.removeUnit(target);
            } else {
                // AI unit
                const ai = this.aiManager.aiPlayers.find(a => a.units.includes(target));
                if (ai) {
                    const idx = ai.units.indexOf(target);
                    if (idx > -1) ai.units.splice(idx, 1);
                }
                this.renderer.killUnit(target); // tip over + fade instead of vanishing
            }
        }

        // Losing a house/Town Center takes its population slots with it. Re-derive
        // the cap from what is LEFT standing (never subtract) — run after the list
        // surgery above so the wreck is already out of the count.
        if (isBuilding && victimOwner) this.recomputeMaxPopulation(victimOwner);

        // A Town Center just fell (razed or demolished — destroyOwnBuilding comes
        // through here too). Run this AFTER the list surgery above so the wreck no
        // longer counts as a drop-off.
        if (isBuilding && target.type === 'town_center' && victimOwner) {
            this.onTownCenterLost(victimOwner);
        }
    }

    // Keep an owner's economy honest after a Town Center dies.
    //   - One still standing: re-aim every hauler at the nearest SURVIVING
    //     drop-off, so nobody marches on to deliver into a crater.
    //   - None left: the delivery economy is pointless, so idle every worker
    //     whose job ends at a drop-off (harvesting, hauling, farming). They stop
    //     hauling to a hole / mining into a full pack and read as IDLE — free to
    //     be re-tasked (e.g. to rebuild). Goods in hand are lost, same as the
    //     fill-up-with-no-Town-Center path already does.
    // Builders are spared (one may be putting up the replacement Town Center), as
    // are repairers, scouts and drafted fighters — their work still means something.
    onTownCenterLost(owner) {
        if (!owner || !owner.units || !owner.buildings) return 0;
        const drops = owner.buildings.filter(b => b.type === 'town_center' && !b.underConstruction && b.health > 0);
        if (drops.length) {
            owner.units.forEach(u => {
                if (u.type !== 'worker' || u.health <= 0) return;
                if (u.task !== 'carrying' || !u.carryingResource) return;
                let best = null, bd = Infinity;
                drops.forEach(tc => { const d = Math.hypot(tc.x - u.x, tc.z - u.z); if (d < bd) { bd = d; best = tc; } });
                if (best) { u.targetX = best.x; u.targetZ = best.z; u.isMoving = true; }
            });
            return 0;
        }
        let idled = 0;
        owner.units.forEach(u => {
            if (u.type !== 'worker' || u.health <= 0) return;
            if (u.task === 'building' || u.isBuilding) return;   // may be rebuilding the Town Center
            if (u.task === 'repairing') return;
            if (u.isAttacking || u.attackTarget) return;         // drafted defenders keep fighting
            const economic = u.task === 'harvesting' || u.task === 'carrying' || u.task === 'farm_work' || !!u.farmRef;
            if (!economic) return;
            if (u.farmRef && u.farmRef.assignedWorker === u) u.farmRef.assignedWorker = null;
            u.farmRef = null;
            u.task = null;
            u.harvestTarget = null;
            u.isHarvesting = false;
            u.harvestTimer = 0;
            u.carryingResource = false;
            u.carryingResourceType = null;
            u.harvestAmount = 0;
            u.isMoving = false;
            u.targetX = u.x;
            u.targetZ = u.z;
            idled++;
        });
        if (idled) console.log(`[Game] ${this.ownerName(owner)} lost its last Town Center — ${idled} worker(s) idled (nowhere to deliver).`);
        return idled;
    }

    // The mirror of onTownCenterLost: a Town Center stands again, so the delivery
    // economy can restart. Anyone still holding goods walks them to the new
    // centre, and idle hands go back onto fields that lost their farmhand when
    // the drop-off vanished — a farm only produces while a worker is assigned,
    // and NO model action can staff one (the builder normally becomes its
    // farmer), so without this a rebuilt base would leave its fields dead.
    onTownCenterBuilt(owner) {
        if (!owner || !owner.units || !owner.buildings) return 0;
        const drops = owner.buildings.filter(b => b.type === 'town_center' && !b.underConstruction && b.health > 0);
        if (!drops.length) return 0;
        const nearestTC = (x, z) => drops.reduce((best, tc) =>
            (!best || Math.hypot(tc.x - x, tc.z - z) < Math.hypot(best.x - x, best.z - z)) ? tc : best, null);
        const busy = u => u.isAttacking || u.attackTarget || u.isBuilding || u.task === 'building' || u.task === 'repairing';
        let resumed = 0;

        // Still holding goods with nowhere to put them → deliver to the new centre.
        owner.units.forEach(u => {
            if (u.type !== 'worker' || u.health <= 0 || busy(u)) return;
            if (!u.carryingResource || !(u.harvestAmount > 0)) return;
            const tc = nearestTC(u.x, u.z);
            if (!tc) return;
            u.task = 'carrying';
            u.targetX = tc.x;
            u.targetZ = tc.z;
            u.isMoving = true;
            resumed++;
        });

        // Idle hands back onto unmanned fields.
        owner.buildings.forEach(f => {
            if (f.type !== 'farm' || f.underConstruction || f.health <= 0) return;
            if (f.assignedWorker && f.assignedWorker.health > 0 && f.assignedWorker.farmRef === f) return;
            const hand = owner.units.find(u => u.type === 'worker' && u.health > 0 && !u.farmRef && this.isIdleWorker(u));
            if (!hand) return;
            f.assignedWorker = hand;
            hand.farmRef = f;
            hand.task = 'farm_work';
            hand.isMoving = true;
            hand.targetX = f.x + (Math.random() - 0.5) * 3;
            hand.targetZ = f.z + (Math.random() - 0.5) * 3;
            resumed++;
        });

        if (resumed) console.log(`[Game] ${this.ownerName(owner)} has a Town Center again — ${resumed} worker(s) back to work.`);
        return resumed;
    }

    isResourceNode(x, z) {
        return this.terrain.resources.some(r => 
            Math.abs(r.x - x) < 3 && Math.abs(r.z - z) < 3
        );
    }

    selectUnit(unit) {
        this.renderer.selectUnit(unit);
        this.updateUnitInfo(unit, null); // routes through the menu-refresh hook
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
        this.updateUnitInfo(null, building); // routes through the menu-refresh hook
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
        // Borrowed a gatherer (no one was idle): say so — it returns by itself.
        if (pick.restore) this.ui.showInfoMessage(t('msg.builderBorrowed'));

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

    trainUnit(unitType, trainerId = null) {
        const unitDef = getUnitDefFor(this.player.civilization, unitType);
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

        // Epoch gate: a bronze warrior must not come out of a neolithic barracks.
        // (The LLM path already checks its train tiers; this human path didn't.)
        const unitTier = unitDef.tier || unitDef.requiredAge;
        if (unitTier) {
            const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
            if (ageOrder.indexOf(unitTier) > ageOrder.indexOf(this.player.age)) {
                this.ui.showErrorMessage(t('msg.unitNeedsAge', { age: this.ui.getAgeName(unitTier) }));
                return;
            }
        }

        // The train menu passes the id of the building it was opened for: honour
        // that choice — the unit spawns at the producing building, so with several
        // Town Centers (or barracks/stables/archery ranges) it must be the one the
        // player actually selected, not the first free one in build order. If the
        // chosen building is busy, say so instead of silently producing elsewhere.
        let trainingBuilding = null;
        const requested = trainerId ? trainers.find(b => b.id === trainerId) : null;
        if (requested) {
            if (requested.isProducing) {
                this.ui.showErrorMessage(t('msg.buildingBusy'));
                return;
            }
            trainingBuilding = requested;
        } else {
            // No building context (or it no longer exists): first FREE trainer —
            // never silently overwrite a building mid-production.
            trainingBuilding = trainers.find(b => !b.isProducing);
        }
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
            if (tech.bonus.healPower) {
                owner.healPowerBonus = (owner.healPowerBonus || 0) + tech.bonus.healPower;
            }
        }
    }

    // One unit, one tech bonus — shared by the research-time retrofit
    // (applyBonusToUnits) and the spawn-time catch-up (applyResearchedBonusesToUnit).
    applyBonusToOneUnit(bonus, appliesTo, unit) {
        // 'all_units' bonuses hit workers AND military alike (Greek Farsight).
        if (appliesTo === 'all_units') {
            if (bonus.visionRange) unit.visionBonus = (unit.visionBonus || 1) + bonus.visionRange;
            return;
        }
        if (unit.type === 'worker' && appliesTo === 'worker') {
            if (bonus.speed) unit.speed *= (1 + bonus.speed);
            if (bonus.harvestRate) unit.harvestRate *= (1 + bonus.harvestRate);
            if (bonus.buildSpeed) unit.buildSpeed *= (1 + bonus.buildSpeed);
        } else if (appliesTo === 'all_military' || appliesTo === unit.unitType) {
            if (bonus.attack) unit.attack += bonus.attack;
            if (bonus.health) {
                unit.health = Math.min(unit.health + bonus.health, unit.maxHealth + bonus.health);
                unit.maxHealth += bonus.health;
            }
            if (bonus.range) unit.range += bonus.range;
            if (bonus.speed) unit.speed *= (1 + bonus.speed);
        }
    }

    // A freshly trained unit gets every already-researched bonus applied, so
    // "Quick Hands" & co. hold for the WHOLE eligible population — createUnit
    // bakes raw def stats, which silently split the roster into fast veterans
    // and slow recruits after a research.
    applyResearchedBonusesToUnit(unit, owner) {
        if (!unit || !owner || !owner.researchedTechs) return;
        const civ = getCivilization(owner.civilization || this.player.civilization);
        if (!civ || !civ.techTree) return;
        Object.keys(owner.researchedTechs).forEach(techId => {
            if (!owner.researchedTechs[techId]) return;
            const tech = civ.techTree[techId];
            if (tech && tech.bonus) this.applyBonusToOneUnit(tech.bonus, tech.appliesTo, unit);
        });
    }

    applyBonusToUnits(bonus, appliesTo, owner) {
        owner = owner || this.player;
        owner.units.forEach(unit => {
            this.applyBonusToOneUnit(bonus, appliesTo, unit);
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
                const options = getTrainOptionsForBuilding(building.type, targetAge, owner.civilization);
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
            const options = getTrainOptionsForBuilding(building.type, age, this.player.civilization);
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
                // Civ-aware: an ageing-up Persian rider must become Persia's OWN
                // heavy cavalry, not the shared one.
                const newDef = getUnitDefFor(owner.civilization, upgradedType);
                if (newDef) {
                    // REALLY remove the unit from the renderer before re-adding:
                    // scene.remove() is a legacy no-op shim, and renderer.units IS
                    // the simulation list (getAllUnits) — the old remove+add pair
                    // duplicated every upgraded veteran, giving it one combat tick
                    // PER COPY each frame: triple-listed champions moved (and hit)
                    // at 3x and "flew over the map".
                    this.renderer.removeUnit(unit);

                    // Upgrade the unit
                    unit.type = upgradedType;
                    unit.name = newDef.name;
                    unit.health = newDef.health;
                    unit.maxHealth = newDef.health;
                    unit.speed = newDef.speed;
                    unit.attack = newDef.attack;
                    unit.range = newDef.range;
                    unit.visionBonus = 1; // reset with the def stats — the catch-up below re-applies it
                    unit.currentTier = newAge;

                    // The raw def stats above just wiped every researched bonus
                    // (Bushido, Iron Working, …) — re-apply them, same catch-up
                    // a freshly trained unit gets, so an age-up never weakens
                    // a veteran relative to a new recruit.
                    this.applyResearchedBonusesToUnit(unit, owner);

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
        // The build menu always shows the full catalogue — selection never filters it.
        this.ui.showBuildMenu();
    }

    showUpgradeMenu() {
        this.ui.showUpgradeMenu();
    }

    closeMenus() {
        this.ui.closeMenus();
    }

    updateUnitInfo(unit, building) {
        this.ui.updateUnitInfo(unit, building);
        // Selection just changed — rebuild any open build/train/research menu NOW
        // (forced past the throttle) so a freshly selected building's card fills
        // instantly instead of waiting for the next economy refresh tick.
        if (this.ui) this.ui.refreshActiveMenu(true);
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
            this.renderer.killUnit(unit); // animated death (tip over + fade)
            this.player.resources.updatePopulation(this.player.units.length);
        }
    }

    addBuilding(building) {
        this.player.buildings.push(building);
        this.renderer.addBuilding(building);

        // Population slots come from what STANDS: a construction site contributes
        // nothing until completeConstruction re-derives the cap. Placing an
        // already-finished building (spawn/debug) re-derives it right away.
        if (!building.underConstruction) this.recomputeMaxPopulation(this.player);
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

    // Shared labor triage — which worker hurts least to pull off its task?
    //   0 idle · 1-4 gatherers (fattest stockpile first, surplus labor is the
    //   most expendable) · 5 repairers · 6 farmers (steady food goes last) ·
    //   7 SCOUTS. Builders and FIGHTING workers return Infinity: never pulled.
    //
    // Scouts used to sit at 5, ahead of repairers and farmers, on the reasoning that a
    // scout is doing nothing productive. That reads the cost backwards. A gatherer
    // pulled from a node loses one trip; a scout pulled mid-journey loses the ENTIRE
    // walk it has already made, and the tile it was sent to is never reached at all.
    // The model then watches an explore it was told succeeded quietly produce nothing,
    // with no way to find out why. Last resort now: taken only when the alternative is
    // not building.
    // Used by pickBuilder (construction) and assign_workers (harvest orders) so
    // both kinds of pull follow one policy. Scouts/repairers need explicit
    // tiers — isIdleWorker() counts both as free.
    workerPullRank(owner, u) {
        if (u.task === 'building' || u.isBuilding) return Infinity;
        if (u.isAttacking || u.attackTarget || u.attackMove) return Infinity;
        if (u.task === 'repairing') return 5;
        if (u.farmRef || u.task === 'farm_work') return 6;
        if (u.task === 'scouting') return 7;
        if ((u.task === 'harvesting' || u.task === 'carrying') && u.harvestTarget) {
            const stockOrder = ['food', 'wood', 'stone', 'gold']
                .sort((a, b) => (owner.resources[b] || 0) - (owner.resources[a] || 0));
            return 1 + stockOrder.indexOf(u.harvestTarget.type); // 1 fattest … 4 leanest
        }
        return 0; // idle (or aimless)
    }

    // Decide who builds `site`: price every worker in SECONDS — the walk there, plus
    // what interrupting its current task costs — and take the cheapest. Idle workers
    // build outright; anyone else is borrowed and resumes its former task afterwards
    // (applyBuilder saves it). Builders and fighting workers are never pulled.
    //
    // This was a strict tier sort: best workerPullRank first, distance only breaking
    // ties INSIDE that tier. Distance therefore could not compete with rank at all, and
    // when the best tier held exactly one worker, "the closest of the pool" was that
    // worker no matter where it stood. Observed live: a scout that had finished
    // exploring — arrived scouts are cleared to task=null, so they rank 0, idle — was
    // walked ~200s across an 800-unit map for a 25s building while farmers and gatherers
    // stood around the site untouched. Nothing malfunctioned; that was the tier sort
    // working as designed, which is why it needed replacing rather than patching.
    //
    // Both costs are time, so they belong in one unit instead of in a ranking that
    // cannot see one of them. Units cover speed*3 u/s (see the movement loop).
    pickBuilder(owner, site, opts = {}) {
        const workers = (owner.units || []).filter(u => u.type === 'worker' && u.health > 0);
        if (!workers.length) return { error: 'no_workers' };
        // Seconds of value destroyed by interrupting each workerPullRank. A gatherer
        // loses the trip it is on; a farmer a steadier income. A scout is priced far
        // above the rest because it loses the whole walk it has ALREADY made and never
        // reaches its tile — so it is taken only when the alternative is a very long
        // trek or not building at all.
        const PULL_SECS = [0, 4, 6, 8, 10, 14, 18, 45];
        let best = null, bestRank = Infinity, bestCost = Infinity;
        for (const u of workers) {
            const rank = this.workerPullRank(owner, u);
            if (rank === Infinity) continue;   // building or fighting: never pulled
            const walk = Math.hypot(u.x - site.x, u.z - site.z) / (((u.speed || 1) * 3) || 3);
            const cost = walk + (PULL_SECS[rank] || 0);
            if (cost < bestCost) { bestCost = cost; best = u; bestRank = rank; }
        }
        if (!best) return { error: 'no_idle' };
        // What it was doing, so the caller can say so. "A worker was pulled off its
        // task" is true and useless: off WHICH task decides whether the model should
        // expect its scout to arrive, its farm to keep producing, or nothing at all.
        const wasDoing = best && (best.task === 'scouting' ? 'scouting'
            : (best.farmRef || best.task === 'farm_work') ? 'farming'
            : best.task === 'repairing' ? 'repairing'
            : (best.harvestTarget ? 'gathering' : null));
        return { worker: best, restore: bestRank > 0, wasDoing };
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

    // Repairs are locked while a building is under fire: only 10 seconds after
    // the LAST hit may workers patch it up — no heal-tanking a live siege.
    // Returns the remaining lockout in ms (0 = repairs allowed).
    repairBarrierMsLeft(building) {
        if (!building || !building._lastDamageTime) return 0;
        return Math.max(0, 10000 - (Date.now() - building._lastDamageTime));
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

    // Demolish one of `owner`'s own buildings and free any farmer. The population
    // bonus is reversed inside destroyTarget (one source for demolition AND
    // combat destruction — it used to be missed entirely when a house fell in war).
    destroyOwnBuilding(building) {
        if (!building) return false;
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
    // Units had NO bounds check at all: isWalkable existed but nothing ever called
    // it, and the six separate places that step a unit's position each moved it
    // freely — so anything chasing, fleeing or gathering could walk off the beach
    // and stand in the sea. One corrective pass, after every sub-step has run,
    // covers all six paths and any future one; clamping at each call site would
    // cover today's and quietly miss tomorrow's.
    keepUnitsAshore() {
        const t = this.terrain;
        if (!t || !t.landLimit) return;
        const seen = new Set();
        const sweep = p => {
            if (!p || !p.units || seen.has(p)) return;
            seen.add(p);
            for (const u of p.units) {
                const cheb = Math.max(Math.abs(u.x), Math.abs(u.z));
                const lim = t.landLimit(u.x, u.z);
                if (cheb <= lim) continue;      // ashore — the common case, no work
                const k = lim / cheb;
                u.x *= k; u.z *= k;
            }
        };
        sweep(this.player);
        ((this.aiManager && this.aiManager.aiPlayers) || []).forEach(sweep);
    }

    // Somewhere a unit can actually STAND. A formation hands out fixed slots, and a
    // slot nobody can occupy is not a slot -- it is a unit walking at a place it will
    // be shoved out of, once a frame, for as long as the order stands. That is the
    // jitter asp67 saw: a rank marching into a base, pinned and vibrating, going
    // nowhere. And with matchSpeed holding the group to its slowest member, units that
    // never arrive are a formation that never arrives.
    //
    // Two things make a spot unstandable. The coast, which clampToMap's square box
    // already keeps well clear of (its +/-370 sits inside a shoreline that runs 390 to
    // 416) -- kept anyway, since it costs nothing and the box is not the coast.
    //
    // And BUILDINGS, which is the one that was actually biting. EngineRenderer pushes
    // every unit out of a radial clearance ring around every building each frame; a
    // slot inside one is a tug of war between the mover and the push-out that neither
    // wins. Resolved the same way the renderer resolves it -- straight out along the
    // radius -- and with the same numbers, because a slot cleared by a different rule
    // than the one enforcing it is a slot that is only sometimes legal.
    //
    // Farms are excluded there, so they are excluded here.
    static get UNIT_BUILDING_CLEARANCE() { return 4.5; }
    static get WONDER_CLEARANCE() { return 7.0; }

    clampSlot(x, z) {
        const p = this.clampToMap(x, z);
        const t = this.terrain;
        let { x: sx, z: sz } = (t && t.clampToLand) ? t.clampToLand(p.x, p.z) : p;

        // One pass out of each ring, nearest first. A slot wedged between two rings can
        // still end up inside one -- the unit is then pushed the last step by the
        // renderer and stands beside its rank instead of in it, which is a formation
        // slightly out of shape rather than a formation that never gets there.
        const blds = this.getAllBuildings ? this.getAllBuildings() : [];
        for (const b of blds) {
            if (!b || b.health <= 0 || b.type === 'farm') continue;
            const clr = (b.isWonder ? Game.WONDER_CLEARANCE : Game.UNIT_BUILDING_CLEARANCE) + 0.5;
            const dx = sx - b.x, dz = sz - b.z;
            const d = Math.hypot(dx, dz);
            if (d >= clr) continue;
            if (d < 0.01) { sx = b.x + clr; continue; }   // dead centre: any direction out
            sx = b.x + (dx / d) * clr;
            sz = b.z + (dz / d) * clr;
        }
        return { x: sx, z: sz };
    }

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

    // Sight radius of a single unit. Cavalry sees 50% farther (22.5 vs 15) — the
    // scouting edge mounted units are supposed to have. Used consistently by the
    // human fog overlay, both AI visibility checks and the exploration tracker.
    // unit.visionBonus is a researched multiplier (e.g. Greek Farsight = 1.2),
    // applied per unit so this hot path never has to look up the owner.
    unitVision(unit) {
        return (unit && unit.unitType === 'cavalry' ? 22.5 : 15) * ((unit && unit.visionBonus) || 1);
    }

    // Sight radius of a building — the twin of unitVision(), and the ONE place
    // every vision system asks (human fog, spectator fog, the rule-based check,
    // the models' exploration grid and their spotting check). Towers stay the
    // long-range sentinels at 60; a Town Center sees HALF a tower (30) — enough
    // to watch its own working area, and one more reason to plant another —
    // while every other building keeps a short 12. Scaffolding is blind: a plot
    // grants nothing until it is finished.
    buildingVision(b) {
        if (!b || b.underConstruction) return 0;
        if (b.type === 'tower') return 60;
        if (b.type === 'town_center') return 30; // 50% of the tower's sweep
        return 12;
    }

    // The population cap is DERIVED from what an owner actually has standing —
    // never accumulated. A running +/- drifted, and badly: an addition ABOVE the
    // hard cap was silently clamped away, but the later demolition still
    // subtracted its bonus in FULL. Overbuild to a true 160 slots (stored as
    // 100), lose enough buildings, and the cap was driven below the truth — even
    // to 0 with Town Centers still standing. Recomputing from the buildings
    // cannot drift, and it self-heals any total already corrupted.
    recomputeMaxPopulation(owner) {
        if (!owner || !owner.resources) return 0;
        let slots = 0;
        (owner.buildings || []).forEach(b => {
            if (!b || b.underConstruction || b.health <= 0) return;
            const def = (typeof getBuildingDef === 'function') ? getBuildingDef(b.type) : null;
            if (def && def.popBonus) slots += def.popBonus;
        });
        owner.resources.maxPopulation = Math.min(MAX_POPULATION_CAP, slots);
        return owner.resources.maxPopulation;
    }

    // ---- Match timeline (for the end-of-match graph) -------------------------
    // A uniform 5-second sample of every player, taken here rather than mined from
    // the transcripts on purpose: transcripts exist only for LLM seats (a mixed
    // match would have holes exactly where you want to compare), their memory ring
    // caps at 300 turns, and each model is sampled at its OWN cadence — a 1.6s model
    // would carry fifteen times the points of a 25s one, which is not a plottable
    // axis. One clock, every seat, no cap.
    //
    // ~1200 samples for a 100-minute match; a few hundred KB at worst.
    static get TIMELINE_MS() { return 5000; }

    // A wonder's life is the win condition running: raised, then held, then either
    // won with or lost. On the graph that is the single most explanatory event a
    // match produces — a player pouring an economy into one building, and an
    // opponent deciding to spend an army removing it.
    noteWonder(building, event) {
        if (!building || !building.isWonder || !this._timeline) return;
        const owner = this.getOwnerByBuilding(building);
        if (!owner) return;
        this._timeline.wonders.push({
            t: Math.max(0, Math.round((Date.now() - this._timeline.t0) / 1000)),
            id: owner.id, event
        });
    }

    resetTimeline() {
        this._timeline = { t0: Date.now(), samples: [], ages: [], exhausted: [], wonders: [] };
        // Handles are per MATCH: without this they keep climbing across restarts in one
        // session, and a transcript's ids stop starting at 1.
        if (typeof resetUnitHandles === 'function') resetUnitHandles();
        this._tlLast = 0;
        this._tlAge = {};        // playerId -> last age seen
        this._tlDry = {};        // playerId -> {type: true} once its discovered nodes ran out
    }

    // Discovered nodes of each type that still hold something, for THIS player.
    // Live amount rather than the remembered one: the marker answers "was there
    // anything left to gather", which is a fact about the world, not about belief.
    discoveredNodeCounts(owner) {
        const out = { food: 0, wood: 0, stone: 0, gold: 0 };
        const idx = owner && owner._knownResIdx;
        if (!idx) return out;
        ((this.terrain && this.terrain.resources) || []).forEach((r, i) => {
            if (r.amount > 0 && out[r.type] !== undefined && idx.has(i)) out[r.type]++;
        });
        return out;
    }

    sampleTimeline(now) {
        if (!this._timeline) this.resetTimeline();
        const tl = this._timeline;
        if (now - this._tlLast < Game.TIMELINE_MS) return;
        this._tlLast = now;
        const t = Math.round((now - tl.t0) / 1000);
        const players = (this.aiManager && this.aiManager.aiPlayers) || [];
        const row = { t, p: {} };
        players.forEach(ai => {
            const g = (ai.resources && ai.resources.gathered) || { food: 0, wood: 0, stone: 0, gold: 0 };
            const alive = ai.buildings.length > 0 || ai.units.length > 0;
            row.p[ai.id] = {
                f: Math.round(g.food || 0), w: Math.round(g.wood || 0),
                s: Math.round(g.stone || 0), o: Math.round(g.gold || 0),
                pw: Math.round((this.ui && this.ui.spectatorPowerScore) ? this.ui.spectatorPowerScore(ai) : 0),
                al: alive ? 1 : 0
            };
            // An eliminated player still "knows" the nodes they scouted, and the
            // survivors go on draining them — which drew ran-dry markers on a seat
            // that had been gone for an hour. A corpse has no news to report.
            if (!alive) return;
            // Age advances: the dotted verticals that turn the graph from a
            // description into an explanation.
            if (this._tlAge[ai.id] !== ai.age) {
                if (this._tlAge[ai.id] !== undefined) tl.ages.push({ t, id: ai.id, age: ai.age });
                this._tlAge[ai.id] = ai.age;
            }
            // ...and the moment a player's OWN known supply of a type ran dry, which
            // is what a collapsing share in the composition strip actually means.
            const disc = this.discoveredNodeCounts(ai);
            // "Ran dry" is a TRANSITION from having some to having none, and the flag
            // starts true — already dry, nothing to report — for exactly that reason.
            //
            // Defaulting to {} instead made never-discovered look identical to
            // just-exhausted, and the "t > 0" guard was a wrong proxy for the difference:
            // it only silenced the very first sample, so the second one fired. Every
            // match therefore opened with "stone ran out" and "gold ran out" for every
            // player five seconds in, before anyone had mined a thing — in one 78-minute
            // match, four of the nine markers were that. The model-facing version of this
            // notice already required a previous non-zero count; the graph's copy never
            // got the same fix, and drifted.
            //
            // Starting true is also simply truthful: a player who has discovered no stone
            // HAS no stone supply, and there is no news in that. The first discovery
            // flips it false through the branch below, and only then can it ran-dry.
            if (!this._tlDry[ai.id]) {
                this._tlDry[ai.id] = { food: true, wood: true, stone: true, gold: true };
            }
            ['food', 'wood', 'stone', 'gold'].forEach(k => {
                const dry = disc[k] === 0;
                if (dry && !this._tlDry[ai.id][k]) {
                    this._tlDry[ai.id][k] = true;
                    tl.exhausted.push({ t, id: ai.id, type: k });
                } else if (!dry) {
                    this._tlDry[ai.id][k] = false;   // found more — it can happen again
                }
            });
        });
        tl.samples.push(row);
    }

    // The A1..G7 label for a world position, on the same grid map.exploration uses
    // and explore() takes. Map geometry, so it lives here rather than in the LLM
    // harness: the spectator's coordinate flag reads it too, and two copies of the
    // same bucketing would eventually disagree about where a tile boundary is.
    tileLabelAt(x, z) {
        const T = this.EXPLORE_TILES || 7;
        const size = (this.terrain && this.terrain.size) || 800;
        const cell = size / T, half = size / 2;
        const col = Math.min(T - 1, Math.max(0, Math.floor((x + half) / cell)));
        const row = Math.min(T - 1, Math.max(0, Math.floor((z + half) / cell)));
        return String.fromCharCode(65 + col) + (row + 1);
    }

    // Spectator probe: WHO actually knows this spot? The rendered fog cannot
    // answer that — in spectator mode it is the UNION of every player's sight
    // and it never fades, so lit ground only proves SOMEONE has been there.
    // This reports per-player knowledge instead: for a resource node, the very
    // set that drives a model's harvest/assign choices (_knownResIdx); for bare
    // ground, that player's explored bitmap.
    discoveryAt(x, z) {
        // A recorded match has no live players to ask, so the analyzer answers for
        // itself from the transcript — same return shape, so the spectator flag needs
        // no idea which mode it is in.
        const an = this.ui && this.ui.analyzer;
        const onAnalyzer = an && an.order && an.order.length
            && document.getElementById('analyzeScreen')
            && document.getElementById('analyzeScreen').classList.contains('active');
        if (onAnalyzer && an.current()) return an.discoveryAt(x, z, an.current()._sec);
        const players = (this.aiManager && this.aiManager.aiPlayers) || [];
        const res = (this.terrain && this.terrain.resources) || [];
        let idx = -1, best = 6;
        res.forEach((r, i) => {
            if (r.amount !== undefined && r.amount <= 0) return;
            const d = Math.hypot(r.x - x, r.z - z);
            if (d < best) { best = d; idx = i; }
        });
        // Report civ AND seat: two players can field the SAME civilization, so
        // the seat badge is the only conclusive identifier.
        const idOf = p => ({ civ: p.civilization, seat: p.seat });
        // Return WHAT it is, not a sentence about it: this used to hand back
        // "food node" as English prose, which the spectator flag then printed
        // untranslated no matter the UI language. The engine names the thing; the
        // UI decides the words.
        if (idx >= 0) {
            const knowers = players.filter(p => p._knownResIdx && p._knownResIdx.has(idx)).map(idOf);
            return { kind: 'node', res: res[idx].type, knowers };
        }
        const G = this.EXPLORE_GRID;
        const size = (this.terrain && this.terrain.size) || 800;
        const cell = size / G, half = size / 2;
        const gx = Math.floor((x + half) / cell), gz = Math.floor((z + half) / cell);
        const knowers = players.filter(p =>
            p._explored && gx >= 0 && gx < G && gz >= 0 && gz < G && p._explored[gz * G + gx] === 1
        ).map(idOf);
        return { kind: 'ground', knowers };
    }

    // The speed a unit walks at RIGHT NOW. Normally its own, which techs and age
    // upgrades keep raising over a match. `marchSpeed` is a per-order override, set by
    // the optional matchSpeed parameter on move_units/attack_target so a mixed force
    // arrives together instead of strung out between its cavalry and its crossbowmen.
    //
    // Held BESIDE `speed`, never written over it. Overwriting would have to be undone,
    // and the undo would land on top of whatever a tech had raised the real speed to in
    // the meantime -- so a march would quietly cancel a research bonus. Clearing an
    // override cannot do that.
    moveSpeedOf(unit, deltaTime) {
        if (!unit) return 1.0;
        const own = unit.speed || 1.0;
        const m = unit.marchSpeed;
        if (!(typeof m === 'number' && m > 0)) return own;
        const pace = Math.min(m, own);
        // matchSpeed sets the pace of the FORMATION, not a leash on every unit. A unit
        // that has to move forward THROUGH its own group -- which is what a half-turn
        // asks of the melee -- can never do it at the shared pace, because everyone it
        // needs to pass is moving just as fast. So it spends a debt instead: it runs at
        // its own speed, and the debt is paid down by the distance it actually GAINS on
        // the formation, not by the distance it covers. When the debt is clear it falls
        // back into the shared pace and the shape holds again.
        const debt = unit.formationCatchup;
        if (!(debt > 0)) return pace;
        if (deltaTime > 0 && own > pace) {
            unit.formationCatchup = Math.max(0, debt - (own - pace) * deltaTime / 1000 * 3);
        }
        return own;
    }

    // Where a unit marching in formation should be heading RIGHT NOW.
    //
    // Aiming straight at its own slot is not enough. Every unit starts from roughly the
    // same spot, so the paths to five slots a few units apart are very nearly parallel:
    // measured on a 385-unit march, a five-man line was 1 unit wide at the start and
    // only reached its full 16 in the last stretch. The army crossed the map as a column
    // and fanned out at the door.
    //
    // So aim at the unit's LANE instead -- the line through its slot along the axis of
    // march -- a short step ahead of wherever it has got to. The lateral error is then a
    // real distance to be walked off at full speed, which happens in the first seconds,
    // and the shape holds for the whole march instead of assembling on arrival.
    static get FORMATION_LOOKAHEAD() { return 10; }

    formationAim(unit, slotX, slotZ) {
        const ax = unit && unit.formationAxis;
        if (!ax) return { x: slotX, z: slotZ };
        const rx = unit.x - slotX, rz = unit.z - slotZ;
        // Negative while the unit is still short of its slot along the march.
        const along = rx * ax.x + rz * ax.z;
        const step = Math.min(0, along + Game.FORMATION_LOOKAHEAD);
        return { x: slotX + ax.x * step, z: slotZ + ax.z * step };
    }

    // ---- Cross-seat contact ---------------------------------------------------
    // One scan, two consumers: a CONTACT line in the sighting seat's recentEvents, and
    // a feed the spectator camera can cut to. They ask the same question -- who just
    // laid eyes on whom -- and asking it twice would be two scans that could disagree
    // about what happened.
    //
    // Three moments, not one. A thing ENTERS sight, it may MOVE while watched, and it
    // LEAVES sight -- and the pair that matters most is the first and the last, because
    // two positions in chronological order are a HEADING, and a heading is what says
    // which way something's home is.
    //
    // Enter and lost are what make that readable inside a SINGLE turn: the aggregation
    // below collapses repeats of one rival's one unit type into a line, so a stream of
    // "still there, moved a bit" reports would arrive as one position however many were
    // logged. "Sighted at A" and "lost at B" are different lines and both survive it.
    //
    // The move report is kept as well but earns its place differently: it is the only
    // signal for something that stays in view for a long time, where enter-and-lost says
    // nothing until it finally goes. Threshold CONTACT_MOVED_DIST of real displacement,
    // so a besieging army parked in view stays quiet. Buildings never move.
    //
    // LOST is also the moment a model's knowledge of a position goes stale, which is a
    // fact worth having on its own -- "it was there and I cannot see it now" is a
    // different state from "it is there".
    //
    // A kill is NOT a lost contact: the thing did not slip away, it died, and KILL/LOSS
    // already say so. Dead entities are dropped silently.
    //
    // Affordable in the buffer it writes to: recentEvents holds 14 and shows 8, and
    // this file already carries two scars from features that flooded it and evicted
    // the UNDER ATTACK warnings. Per-seat, per-turn, CONTACT may take at most
    // CONTACT_MAX_PER_TURN of those slots -- it is context, and it does not get to
    // push out the report that something is being destroyed right now.
    //
    // Reported ONLY where the seat can actually see: the same vision radii its own fog
    // uses. A contact for something a seat could not have seen would be the harness
    // handing it a free scout.
    // Per TURN, and it has to be counted as such. This is enforced where the lines are
    // written, which happens about once a second per seat -- so a cap applied per scan
    // is a cap of itself times the length of a turn, and a 45-second turn against a
    // 14-slot ring would leave the ring holding nothing but contacts. The budget resets
    // when the seat's state-build counter moves, which is the same clock the entries
    // expire on.
    //
    // Four of the eight lines a model is shown: enough for a sighting, a move and a loss
    // with one spare, and it still leaves half the window for the report that something
    // is being destroyed right now.
    static get CONTACT_MAX_PER_TURN() { return 4; }
    // Roughly ten seconds of walking for a scout, and further than a unit can drift by
    // standing still. Below this a contact is the same contact.
    static get CONTACT_MOVED_DIST() { return 25; }
    // How far a thing must have gone between being sighted and being lost for the pair
    // to be worth two lines. A pair that names one coordinate twice is not a heading,
    // it is the same fact said twice -- something sitting on the edge of vision,
    // flickering in and out without going anywhere.
    //
    // The number is measured, not chosen. Across a real match the nineteen
    // sighted-then-lost pairs fall in two clumps and nothing lies between them: TWELVE
    // at exactly 0.0, then 5.8, 6.4, 10.0, 13.2, 14.0, 15.1, 36.2. So the cut belongs
    // in the empty space, and anywhere from 2 to 5 drops all twelve and keeps all
    // seven. Three: clear of the +/-1 that integer coordinates can invent, and clear of
    // the smallest real movement by nearly a factor of two.
    //
    // Deliberately NOT set to the eight I first guessed at, which would have thrown
    // away the 5.8 and the 6.4 -- two units that genuinely walked somewhere, and whose
    // bearings are exactly what the pair exists to carry. A stationary thing is the
    // only thing being filtered here.
    static get CONTACT_FLAP_DIST() { return 3; }
    // ...and how many turns before a thing parked at the edge is worth mentioning again
    // even though it has not moved.
    static get CONTACT_FLAP_TURNS() { return 3; }
    static get CONTACT_CAMERA_RANGE() { return 100; }

    // ONE seat per call, cycling. The scan is O(my things x their things) and at four
    // seats of 200 it measured 11.9ms done all at once -- a 12ms stall inside a 16ms
    // frame, four times a second, for a spectator convenience. Round-robin at the same
    // 4Hz gives each seat a look once a second and costs a quarter of that per tick.
    //
    // Nothing is lost to the delay: the fastest unit in the game covers 2.2 units in
    // that second, against vision radii of 12 to 60. A contact cannot slip through a
    // gap that small.
    detectContacts() {
        const players = (this.aiManager && this.aiManager.aiPlayers) || [];
        if (players.length < 2) return;
        this._contactTurnIdx = ((this._contactTurnIdx || 0) + 1) % players.length;
        const only = players[this._contactTurnIdx];
        const cam = [];

        // Vision sources per seat, built once: living units and FINISHED buildings,
        // the same rule the fog uses (a construction plot sees nothing).
        const eyes = new Map();
        players.forEach(p => {
            const list = [];
            (p.units || []).forEach(u => { if (u.health > 0) list.push({ e: u, r: this.unitVision(u) }); });
            (p.buildings || []).forEach(b => {
                if (b.health > 0 && !b.underConstruction) list.push({ e: b, r: this.buildingVision(b) });
            });
            eyes.set(p, list);
        });

        players.forEach(viewer => {
            if (viewer !== only) return;
            const seen = viewer._contactSeen || (viewer._contactSeen = new Map());
            const nowSeen = new Map();
            const fresh = new Map();     // "seat|type" -> {n, x, z, dist}
            const lost = new Map();      // the same, for things that just left sight
            const turnSeq = viewer._turnSeq || 0;
            // Short memory of what went out of sight and where, so a thing bobbing on
            // the edge of vision is recognised as the same thing coming back.
            const gone = viewer._contactGone || (viewer._contactGone = new Map());
            if (gone.size > 400) gone.clear();        // a match-long map is a leak
            const myEyes = eyes.get(viewer) || [];
            if (!myEyes.length) { viewer._contactSeen = nowSeen; return; }

            // One circle around everything this seat owns, so a rival on the far side of
            // the map is dismissed in a single hypot instead of one per unit I own. At
            // 200 units a side that is the difference between a quarter of a million
            // distance checks a second and a few thousand: the inner loop only runs for
            // rivals that are plausibly close to SOMETHING of mine.
            let cx = 0, cz = 0;
            myEyes.forEach(s => { cx += s.e.x; cz += s.e.z; });
            cx /= myEyes.length; cz /= myEyes.length;
            let reach = 0;
            myEyes.forEach(s => {
                const d = Math.hypot(s.e.x - cx, s.e.z - cz) + Math.max(s.r, Game.CONTACT_CAMERA_RANGE);
                if (d > reach) reach = d;
            });

            players.forEach(other => {
                if (other === viewer) return;
                const targets = [];
                (other.units || []).forEach(u => { if (u.health > 0) targets.push(u); });
                (other.buildings || []).forEach(b => { if (b.health > 0) targets.push(b); });
                const pairBest = { dist: Infinity, x: 0, z: 0, target: null, mine: null, hit: false };

                targets.forEach(t => {
                    // Cheap rejection first: outside the circle round everything I own,
                    // no eye of mine can see it and no unit of mine is near it.
                    if (Math.hypot(t.x - cx, t.z - cz) > reach) return;
                    // Both answers in one pass: the CLOSEST of my things to it (the
                    // camera's question, which counts near misses nobody saw) and
                    // whether any of them could actually see it (the event's question).
                    // No early exit -- breaking on the first seeing eye leaves `best` a
                    // partial minimum, and the camera would then read a distance that
                    // is merely the first one tried.
                    let best = Infinity, sawAt = null, nearMine = null;
                    for (const src of myEyes) {
                        const d = Math.hypot(src.e.x - t.x, src.e.z - t.z);
                        // Prefer a UNIT over a building at equal distance: the shot is
                        // "from the thing that walked into them", and a barracks did not
                        // walk anywhere.
                        if (d < best || (d === best && nearMine && nearMine.type &&
                                         BUILDING_DEFS[nearMine.type] && !BUILDING_DEFS[src.e.type])) {
                            best = d; nearMine = src.e;
                        }
                        if (sawAt === null && d <= src.r) sawAt = d;
                    }
                    if (sawAt !== null) {
                        const key = String(t.id);
                        const was = seen.get(key);
                        // Coming back into view having not gone anywhere is not news. It
                        // is the same thing standing where we last saw it, which the
                        // model was already told; saying it again spends a line to
                        // repeat a coordinate. After a few turns it is worth confirming.
                        const back = !was && gone.get(key);
                        const parked = back && Math.hypot(t.x - back.x, t.z - back.z) < Game.CONTACT_FLAP_DIST
                                            && (turnSeq - back.seq) < Game.CONTACT_FLAP_TURNS;
                        // New, or it has gone somewhere since we last said so.
                        const moved = was && Math.hypot(t.x - was.rx, t.z - was.rz) >= Game.CONTACT_MOVED_DIST;
                        const report = (!was && !parked) || moved;
                        if (back) gone.delete(key);
                        // TWO positions are kept, and the difference between them is the
                        // whole point.
                        //   rx,rz -- where we last SAID it was. The move threshold measures
                        //     from here, or a unit creeping 24 units a look would never trip
                        //     it by inches.
                        //   x,z -- where it is NOW, refreshed every look whether or not
                        //     anything was said. This is what a loss reports, and it has to
                        //     be the last place it was SEEN rather than the last place it was
                        //     mentioned: reporting the latter puts the loss at the same
                        //     coordinate as the sighting, and two identical points are not a
                        //     heading, which was the entire reason for reporting the loss.
                        // The entity and its name ride along so the loss can be reported
                        // without a second search for something by then out of sight.
                        nowSeen.set(key, {
                            x: t.x, z: t.z,
                            rx: report ? t.x : (was ? was.rx : t.x),
                            rz: report ? t.z : (was ? was.rz : t.z),
                            // Where THIS pass through our vision began. The loss is
                            // measured against it, not against the last thing we said.
                            sx: was ? was.sx : t.x,
                            sz: was ? was.sz : t.z,
                            e: t, who: this.seatLabel(other), type: t.type || 'unit'
                        });
                        if (report) {
                            const k = this.seatLabel(other) + '|' + (t.type || 'unit');
                            const cur = fresh.get(k);
                            if (!cur) {
                                fresh.set(k, { n: 1, x: t.x, z: t.z, dist: sawAt,
                                               who: this.seatLabel(other), type: t.type || 'unit' });
                            } else {
                                cur.n++;
                                // Report the nearest one of its kind: that is the one
                                // whose position is worth having.
                                if (sawAt < cur.dist) { cur.dist = sawAt; cur.x = t.x; cur.z = t.z; }
                            }
                        }
                    }
                    // The camera cuts to ONE thing. Keeping every pair inside 100
                    // built 417 throwaway objects a scan in a big fight, to choose one
                    // from — so keep only the closest for this pair of seats.
                    if (best <= Game.CONTACT_CAMERA_RANGE && best < pairBest.dist) {
                        pairBest.dist = best; pairBest.x = t.x; pairBest.z = t.z;
                        pairBest.target = t; pairBest.mine = nearMine; pairBest.hit = true;
                    }
                });
                if (pairBest.hit) {
                    cam.push({ viewer, other, dist: pairBest.dist, x: pairBest.x, z: pairBest.z,
                               target: pairBest.target, mine: pairBest.mine, at: Date.now() });
                }
            });

            // Gone from sight: in the last look, not in this one. Reported at the last
            // place it WAS, which with the sighting that opened the pass is a heading.
            seen.forEach((was, key) => {
                if (nowSeen.has(key) || !was || !was.e) return;
                if (was.e.health <= 0) return;         // killed, not lost — KILL/LOSS said it
                // Remembered either way, so that coming straight back is not "new".
                gone.set(key, { x: was.x, z: was.z, seq: turnSeq });
                // Lost where it was found: the pair draws no line, so it is one fact
                // reported twice. The sighting already said where it is.
                if (Math.hypot(was.x - was.sx, was.z - was.sz) < Game.CONTACT_FLAP_DIST) return;
                const k = was.who + '|' + was.type + '|lost';
                const cur = lost.get(k);
                if (!cur) lost.set(k, { n: 1, x: was.x, z: was.z, who: was.who, type: was.type });
                else cur.n++;
            });

            viewer._contactSeen = nowSeen;
            if (!fresh.size && !lost.size) return;
            // Closest first: if only a few lines fit, they should be the ones most about
            // to matter. Sightings before losses -- something arriving outranks something
            // leaving -- but a loss still gets a slot, because dropping it is what would
            // leave a heading half-drawn.
            // One budget for the whole turn, refilled when the seat next builds a state.
            const seq = viewer._turnSeq || 0;
            if (viewer._contactBudgetSeq !== seq) {
                viewer._contactBudgetSeq = seq;
                viewer._contactBudget = Game.CONTACT_MAX_PER_TURN;
            }
            if (!(viewer._contactBudget > 0)) return;

            const at = (o) => `(${Math.round(o.x)}, ${Math.round(o.z)})`;
            const many = (o) => o.n > 1 ? `${o.n}x ` : '';
            const seenLines = [...fresh.values()].sort((a, b) => a.dist - b.dist)
                .map(f => `CONTACT: ${many(f)}${f.who}'s ${f.type} sighted at ${at(f)}`);
            const lostLines = [...lost.values()]
                .map(l => `CONTACT LOST: ${many(l)}${l.who}'s ${l.type}, last seen at ${at(l)}`);
            // Losses first when the budget is nearly out: a sighting with no loss is a
            // position, a loss with no sighting still says the thing is no longer where
            // the model last had it, and the pair is worth more than a second position.
            const lines = (viewer._contactBudget <= lostLines.length)
                ? lostLines.concat(seenLines) : seenLines.concat(lostLines);
            lines.slice(0, viewer._contactBudget).forEach(line => {
                viewer._contactBudget--;
                this.logPlayerEvent(viewer, line, 1);
            });
        });

        // Kept PER VIEWER, because only one was scanned: overwriting the whole feed
        // each tick would leave the camera looking at a single seat's contacts and
        // blind to the other three until their turn came round.
        this._contactFeedBy = this._contactFeedBy || {};
        this._contactFeedBy[only.id] = cam;
        this._contactFeed = Object.keys(this._contactFeedBy)
            .reduce((all, k) => all.concat(this._contactFeedBy[k]), [])
            .sort((a, b) => a.dist - b.dist);
    }

    // ---- Exploration tracking (per player) ------------------------------------
    // A coarse "ground I have ever seen" bitmap per player, marked every
    // discovery sweep (250ms) around every living unit and building. Aggregated
    // into a 7×7 tile summary that the LLM state exposes as map.exploration —
    // small enough to send every turn, granular enough to steer scouting
    // toward genuinely dark parts of the map.
    markExploration(owner) {
        if (!owner) return;
        const G = this.EXPLORE_GRID;
        if (!owner._explored || owner._explored.length !== G * G) owner._explored = new Uint8Array(G * G);
        const size = (this.terrain && this.terrain.size) || 800;
        const cell = size / G;
        const half = size / 2;
        const grid = owner._explored;
        const mark = (x, z, range) => {
            const cr = Math.ceil(range / cell);
            const cx = Math.floor((x + half) / cell);
            const cz = Math.floor((z + half) / cell);
            for (let dz = -cr; dz <= cr; dz++) {
                for (let dx = -cr; dx <= cr; dx++) {
                    const gx = cx + dx, gz = cz + dz;
                    if (gx < 0 || gx >= G || gz < 0 || gz >= G) continue;
                    const wx = (gx + 0.5) * cell - half;
                    const wz = (gz + 0.5) * cell - half;
                    if (Math.hypot(wx - x, wz - z) <= range) grid[gz * G + gx] = 1;
                }
            }
        };
        (owner.units || []).forEach(u => { if (u.health > 0) mark(u.x, u.z, this.unitVision(u)); });
        (owner.buildings || []).forEach(b => {
            if (b.health > 0) mark(b.x, b.z, this.buildingVision(b));
        });
    }

    // Percent (0-100) of each map tile this player has ever seen, as a 7×7
    // row-major grid: out[row][col], row 0 = north edge (z=-half), col 0 =
    // west edge (x=-half). Finer than the old 3×3 compass so models can aim
    // scouts at genuinely dark tiles instead of whole map ninths.
    explorationSummary(owner) {
        const T = this.EXPLORE_TILES;
        const out = Array.from({ length: T }, () => new Array(T).fill(0));
        if (!owner || !owner._explored) return out;
        const G = this.EXPLORE_GRID, S = G / T; // 6 bitmap cells per tile side
        for (let tz = 0; tz < T; tz++) {
            for (let tx = 0; tx < T; tx++) {
                let seen = 0;
                for (let z = tz * S; z < (tz + 1) * S; z++) {
                    for (let x = tx * S; x < (tx + 1) * S; x++) seen += owner._explored[z * G + x];
                }
                out[tz][tx] = Math.round((seen / (S * S)) * 100);
            }
        }
        return out;
    }

    // Persistent first-contact memory: has `viewer` ever SEEN any unit or
    // building of each rival? Drives the discovery gate on rival army/building
    // counts (epochs stay public — heralds announce age-ups). Monotonic: once
    // met, always met. The human viewer uses its fog (what was actually shown
    // on screen); AI viewers use the same live vision as their discovery.
    updateRivalContacts(viewer) {
        if (!viewer) return;
        if (!viewer._metRivals) viewer._metRivals = new Set();
        const isHuman = viewer === this.player;
        const canSee = (x, z) => isHuman
            ? !!(this.fogOfWar && this.fogOfWar.isPositionVisible(x, z))
            : this.aiManager.isVisibleTo(viewer, x, z);
        const consider = (owner, key) => {
            if (owner === viewer || viewer._metRivals.has(key)) return;
            const spotted = (owner.units || []).some(u => u.health > 0 && canSee(u.x, u.z)) ||
                            (owner.buildings || []).some(b => b.health > 0 && canSee(b.x, b.z));
            if (spotted) viewer._metRivals.add(key);
        };
        this.aiManager.aiPlayers.forEach(o => consider(o, o.id));
        if (!this.spectatorMode && this.player) consider(this.player, 'player');
    }

    // Centre of this player's least-explored map tile (7×7 — the same grid the
    // models see) — where a scout learns the most. Ties break in reading order
    // (NW corner first); callers add jitter so repeated picks spread within
    // the tile.
    leastExploredSection(owner) {
        const sum = this.explorationSummary(owner);
        const T = this.EXPLORE_TILES;
        const size = (this.terrain && this.terrain.size) || 800;
        const tile = size / T;
        let br = 0, bc = 0;
        for (let r = 0; r < T; r++) {
            for (let c = 0; c < T; c++) {
                if (sum[r][c] < sum[br][bc]) { br = r; bc = c; }
            }
        }
        return {
            name: `tile[${br}][${bc}]`,
            pct: sum[br][bc],
            x: Math.round((bc + 0.5) * tile - size / 2),
            z: Math.round((br + 0.5) * tile - size / 2)
        };
    }

    // Finish a construction site: full HP, becomes functional, grants pop bonus.
    completeConstruction(building) {
        if (!building || !building.underConstruction) return;
        this.noteWonder(building, 'built');   // no-op unless it IS a wonder
        building.underConstruction = false;
        building.buildProgress = building.buildTime || 0;
        building.health = building.maxHealth;
        const owner = this.getOwnerByBuilding(building);
        // Re-derive the cap from everything standing (never accumulate).
        if (owner) this.recomputeMaxPopulation(owner);
        // Populate train options for military buildings (barracks/stable/archery_range)
        // for THIS owner's age — otherwise LLM/freshly-built buildings can't train.
        if (typeof getTrainOptionsForBuilding === 'function') {
            const opts = getTrainOptionsForBuilding(building.type, owner ? owner.age : 'stone', building.civilization);
            if (opts && opts.length) building.trainOptions = opts;
        }
        if (this.renderer && this.renderer.onBuildingCompleted) {
            this.renderer.onBuildingCompleted(building);
        }
        // A drop-off exists again: wake the economy that stalled without one.
        if (building.type === 'town_center' && owner) this.onTownCenterBuilt(owner);
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
        // State 4's walk raises isMoving now, so drop it here: without this a
        // builder released mid-walk (site destroyed under it) would keep the flag,
        // fall through to State 1 once its task is cleared, and march off after
        // whatever stale targetX it happened to be carrying. Every restore branch
        // below re-raises it WITH a fresh target of its own.
        unit.isMoving = false;
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
            this.renderer.killBuilding(building); // animated collapse (crumple + dust)
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

    // A worker's node ran dry: send it to the nearest node of the SAME type that
    // its owner has actually DISCOVERED; it only goes idle when none is left.
    // Discovery honours each owner's own knowledge — fog exploration for the human
    // player, the _knownResIdx scouting memory for AI players (rule-based and LLM
    // alike) — so nobody walks to a node they have never seen.
    retargetDepletedWorker(unit, owner) {
        const wantType = unit.harvestTarget && unit.harvestTarget.type;
        // Say it once per node, to the owner only. A model that assigned workers to a
        // node its state still listed -- because the state reports what the player
        // BELIEVES, and belief lags what its own crew has just walked in on -- got an
        // "OK", then nothing, and no way to find out why. The workers went and looked,
        // which is exactly the evidence that corrects knownAmount, so telling the owner
        // leaks nothing it has not already earned.
        const node = unit.harvestTarget;
        if (node && wantType && owner && this.logPlayerEvent) {
            if (!owner._dryNodesTold) owner._dryNodesTold = new Set();
            const key = wantType + '@' + Math.round(node.x) + ',' + Math.round(node.z);
            if (!owner._dryNodesTold.has(key)) {
                owner._dryNodesTold.add(key);
                this.logPlayerEvent(owner, `The ${wantType} at (${Math.round(node.x)}, ${Math.round(node.z)}) `
                    + `was already exhausted when your workers reached it — they are moving on to the nearest `
                    + `${wantType} you have discovered, or going idle if you have none left.`);
            }
        }
        // Continue nearest to the DEPLETED NODE, not to wherever the worker
        // happens to stand (often the Town Center mid-delivery — measuring from
        // there sent miners to a "nearest to base" node far across the map
        // instead of the next rock in their quarry).
        const fromX = unit.harvestTarget ? unit.harvestTarget.x : unit.x;
        const fromZ = unit.harvestTarget ? unit.harvestTarget.z : unit.z;
        unit.task = null;
        unit.harvestTarget = null;
        unit.isHarvesting = false;
        unit.harvestTimer = 0;
        if (!wantType || !this.terrain || !this.terrain.resources) return;

        const isHuman = owner === this.player;
        let best = null, bestDist = Infinity;
        this.terrain.resources.forEach((r, idx) => {
            if (r.type !== wantType || r.amount === undefined || r.amount <= 0) return;
            const known = isHuman
                ? (!this.fogOfWar || this.fogOfWar.isPositionVisible(r.x, r.z))
                : !!(owner._knownResIdx && owner._knownResIdx.has(idx));
            if (!known) return;
            const d = Math.hypot(r.x - fromX, r.z - fromZ);
            if (d < bestDist) { bestDist = d; best = r; }
        });
        if (!best) return; // nothing of this type discovered & left → idle

        unit.task = 'harvesting';
        unit.harvestTarget = best;
        unit.isMoving = true;
        unit.targetX = best.x + (Math.random() - 0.5) * 2;
        unit.targetZ = best.z + (Math.random() - 0.5) * 2;
    }

    updateWorkerTasks(deltaTime) {
        this.getAllUnits().forEach(unit => {
            if (unit.type !== 'worker') return;
            // A fighting worker belongs to updateCombat (same rule as
            // updateUnitMovement) — the economy mover otherwise drives it a
            // SECOND time per tick toward the combat targetX, doubling its
            // chase speed and shoving it onto the enemy's exact spot.
            if (unit.isAttacking) return;

            // Get owner's resources and buildings
            const owner = this.getOwner(unit);
            if (!owner) return;
            const resources = owner.resources;
            const buildings = owner.buildings;
            
            // --- STATE MACHINE: moving, harvesting, carrying, dropping ---
            
            // State 1: Moving to target (resource, town center, or move command).
            // Builders and repairers are EXCLUDED: they do their own walking in
            // States 4/4b, toward a live buildTarget/repairTarget rather than the
            // targetX/targetZ this state chases. `isMoving` doubles as this state's
            // SELECTOR, which is why applyBuilder sets it false — that was the only
            // way to hand a worker to State 4, and the renderer (which reads the
            // same flag for animation) therefore saw a builder as idle and hovered
            // it to the site with frozen legs. Naming the task here lets the walk
            // states raise isMoving honestly without being hijacked back into this
            // one, where a stale targetX would drag them the wrong way entirely.
            // No-op for today's states: a builder always arrived here with
            // isMoving false anyway.
            if (unit.isMoving && unit.task !== 'building' && unit.task !== 'repairing') {
                // A node can run dry WHILE we walk to it -- usually our own crew
                // finishes it. The depletion check in State 2 only fires once a worker
                // has ARRIVED and started harvesting, so until now a crew dispatched to
                // a node that emptied mid-journey walked the whole way to bare ground,
                // stood there a tick, and only then looked for somewhere else to go.
                // Across a desert map that is a long march for nothing.
                //
                // Carriers are exempt: they are walking to the Town Center with a load
                // and their harvestTarget is only where they mean to return afterwards.
                if (unit.task === 'harvesting' && !unit.carryingResource && unit.harvestTarget
                    && !unit.harvestTarget.isFarm && unit.harvestTarget.amount !== undefined
                    && unit.harvestTarget.amount <= 0) {
                    this.retargetDepletedWorker(unit, owner);
                    return;
                }
                const dx = unit.targetX - unit.x;
                const dz = unit.targetZ - unit.z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                
                // Carriers target the town-center CENTER and "arrive" as soon as they
                // touch its drop radius — so they unload wherever they reach it (any
                // side), instead of all funnelling to one fixed drop point.
                const arrivalThreshold = (unit.task === 'carrying') ? 5.5 :
                                         (unit.task === 'harvesting') ? 2 : 0.5;
                
                if (dist > arrivalThreshold) {
                    unit.isMoving = true; // the mover owns the flag, not whichever caller assigned the task
                    const moveSpeed = this.moveSpeedOf(unit, deltaTime) * deltaTime / 1000 * 3;
                    unit.x += (dx / dist) * moveSpeed;
                    unit.z += (dz / dist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                } else {
                    // Arrived at target. Only PLAIN moves snap onto the exact point —
                    // harvesters and carriers used to be teleported ONTO their target
                    // (the node center ±1 / the TC center), which put workers INSIDE
                    // rocks, gold and bushes while mining, and inside the TC for a
                    // frame when delivering.
                    unit.isMoving = false;
                    if (arrivalThreshold <= 0.5) {
                        unit.x = unit.targetX;
                        unit.z = unit.targetZ;
                    }

                    // If harvesting task and at resource, start harvesting — from the
                    // node's RIM: if the stop position landed inside the node's visual
                    // radius, project it outward along the approach direction (every
                    // assignment path funnels through here, so one fix covers all).
                    if (unit.task === 'harvesting' && unit.harvestTarget && !unit.carryingResource) {
                        const n = unit.harvestTarget;
                        if (!n.isFarm) {
                            const RIM = { stone: 2.1, gold: 1.9, food: 1.45, wood: 0.9 };
                            const rim = RIM[n.type] || 1.2;
                            let rx = unit.x - n.x, rz = unit.z - n.z;
                            let rd = Math.hypot(rx, rz);
                            if (rd < rim) {
                                if (rd < 0.01) { // dead-center: spread by a stable per-unit angle
                                    const a = ((unit.id || '').length * 2.4 + n.x * 0.13 + n.z * 0.17) % 6.283;
                                    rx = Math.cos(a); rz = Math.sin(a); rd = 1;
                                }
                                unit.x = n.x + (rx / rd) * rim;
                                unit.z = n.z + (rz / rd) * rim;
                            }
                        }
                        unit.isHarvesting = true;
                        unit.harvestTimer = 0;
                    }
                    // A scout that has arrived has finished scouting. explore sets this
                    // task and nothing cleared it, so the worker stayed labelled a scout
                    // for the rest of the match: counted under workers.scouting, never
                    // under workers.idle, and refused by assign_workers from:"idle" --
                    // while isIdleWorker(), and therefore pickBuilder, considered the
                    // very same worker free. Two classifiers, one question, which is the
                    // trap the farm-worker counting comment in buildGameStateJSON was
                    // written about.
                    //
                    // The rule-based manager has cleared this for years (ai.js
                    // manageWorkers, step a) -- so the workaround existed and was applied
                    // to exactly the players nobody is measuring. Doing it here covers
                    // every owner, and leaves that one as a backstop for its other case:
                    // a scout that never arrives at all.
                    if (unit.task === 'scouting') unit.task = null;
                    this.renderer.updateUnitPosition(unit);
                }
                // While moving, skip other task logic
                return;
            }
            
            // State 2: Harvesting at resource (not moving)
            if (unit.task === 'harvesting' && unit.isHarvesting && unit.harvestTarget) {
                // Node emptied (e.g. by another worker) while we stood on it: walk
                // on to the nearest DISCOVERED node of the same type (idle if none).
                if (!unit.harvestTarget.isFarm && unit.harvestTarget.amount !== undefined && unit.harvestTarget.amount <= 0) {
                    this.retargetDepletedWorker(unit, owner);
                    return;
                }
                unit.harvestTimer = (unit.harvestTimer || 0) + deltaTime;
                // Harvest bonuses (civ + techs) apply ONCE, to the AMOUNT per trip.
                // They used to scale the tick time AND the amount — Persia's "20%"
                // compounded to 1.44x (and stacked further with harvest techs).
                const harvestTime = 2000;

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
                            // The crew that emptied it KNOWS. A seat's belief about a node
                            // is otherwise refreshed only by having something standing near
                            // it at the moment a snapshot is built -- so a lone worker that
                            // drained the last of one and walked off to deliver left its own
                            // seat still believing the node full. The state then listed it,
                            // assign_workers accepted on that same belief, and the next crew
                            // was sent the whole way back to bare ground. Which is exactly
                            // the report this came from.
                            //
                            // Leaks nothing: this miner was standing on the node. Only its
                            // OWN owner is corrected, so a rival draining a remembered node
                            // out of sight stays fogged, which is what knownAmount is for.
                            if (owner && owner._knownResAmt && this.terrain.resources) {
                                // depleteResourceNode keeps the node in the array (fog
                                // indices are positional), so this index stays valid.
                                const ni = this.terrain.resources.indexOf(unit.harvestTarget);
                                if (ni >= 0) owner._knownResAmt[ni] = 0;
                            }
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
                    } else {
                        // No finished Town Center to deliver to (destroyed, or the only
                        // one is still under construction): the goods have nowhere to
                        // go. Drop them and go IDLE — before this, the worker froze in a
                        // state no branch processed (task 'harvesting' but not
                        // isHarvesting, still carrying), which the owner's state
                        // reported as "returning" forever, hiding a usable worker.
                        unit.carryingResource = false;
                        unit.carryingResourceType = null;
                        unit.harvestAmount = 0;
                        unit.task = null;
                        unit.harvestTarget = null;
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
                    } else if (!unit.harvestTarget.isFarm) {
                        // Node ran dry while we were delivering: continue on the
                        // nearest discovered node of the same type (idle if none).
                        this.retargetDepletedWorker(unit, owner);
                    } else {
                        // Empty farm wrapper: idle (the farm branch below may still
                        // re-assign a dedicated farmhand).
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
                // Nothing resumed the job (harvestTarget was cleared mid-carry and there
                // is no farm): become idle. Without this the worker lingered with
                // task='carrying' and empty hands — a state no branch processes, which
                // the game state reported as "returning" forever.
                if (unit.task === 'carrying') {
                    unit.task = null;
                    unit.harvestTarget = null;
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
                    // A mover OWNS the flags its motion implies. applyBuilder sets
                    // isMoving=false when it hands out the job and nothing here ever
                    // set it back, so the renderer saw isHarvesting/isBuilding/isMoving
                    // all false, picked 'idle', and the builder slid to the site with
                    // frozen legs — it hovered. (Harvesting only escaped this because
                    // its assigner happens to set isMoving itself; the animation
                    // depended on which caller remembered.) Facing reads isMoving too.
                    unit.isMoving = true;
                    const moveSpeed = this.moveSpeedOf(unit, deltaTime) * deltaTime / 1000 * 3;
                    unit.x += (dx / dist) * moveSpeed;
                    unit.z += (dz / dist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                    return;
                }

                // At the site: contribute build progress (multiple workers stack)
                unit.isBuilding = true;
                unit.isMoving = false; // arrived — drop the walk flag the mover raised
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
                    unit.isMoving = false; // same reason as releaseBuilder: don't leak the walk flag into State 1
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
                    unit.isMoving = true; // same as the build walk above — the mover owns the flag
                    const moveSpeed = this.moveSpeedOf(unit, deltaTime) * deltaTime / 1000 * 3;
                    unit.x += (dx / dist) * moveSpeed;
                    unit.z += (dz / dist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                    return;
                }
                // Repair barrier: a building hit within the last 10s cannot be
                // patched. The worker STAYS on the job (task/repairTarget kept)
                // and resumes automatically the moment the barrier lifts.
                if (this.repairBarrierMsLeft(b) > 0) {
                    unit.isBuilding = false;
                    unit.isMoving = false; // standing by at the wall, not walking on the spot
                    return;
                }
                // At the building: restore health (~50 HP/s, workers stack).
                unit.isBuilding = true;
                unit.isMoving = false; // arrived — drop the walk flag the mover raised
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

                // No finished Town Center = nowhere to put the food, so don't work
                // the field at all: release it and go IDLE. Farming on regardless
                // only filled the pack with produce that had to be thrown away.
                if (!buildings.some(b => b.type === 'town_center' && !b.underConstruction && b.health > 0)) {
                    if (farm.assignedWorker === unit) farm.assignedWorker = null;
                    unit.farmRef = null;
                    unit.task = null;
                    unit.isMoving = false;
                    unit.isHarvesting = false;
                    unit.harvestTimer = 0;
                    unit.carryingResource = false;
                    unit.carryingResourceType = null;
                    unit.harvestAmount = 0;
                    return;
                }

                // If farm has food to harvest and worker is not carrying
                if (farm.foodAmount >= 10 && !unit.carryingResource && !unit.isMoving) {
                    // Harvest from farm
                    unit.harvestTimer = (unit.harvestTimer || 0) + deltaTime;
                    // Same single application as node harvesting: bonus on AMOUNT only.
                    const harvestTime = 2000;

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
                        } else {
                            // Backstop: the last Town Center fell between the check
                            // above and this harvest tick. Drop the load and idle —
                            // holding it froze the farmhand in a state NO branch
                            // processes (task 'farm_work' while carrying), so it
                            // never delivered again even once a new centre went up.
                            unit.carryingResource = false;
                            unit.carryingResourceType = null;
                            unit.harvestAmount = 0;
                            if (farm.assignedWorker === unit) farm.assignedWorker = null;
                            unit.farmRef = null;
                            unit.task = null;
                            unit.isMoving = false;
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
                // Farms need a drop-off to be worth working. Without a finished Town
                // Center this auto-assign fought the farm branch's release — it
                // re-hired the very hand that had just walked off the field, so the
                // pair oscillated and the worker kept "attending" a farm whose
                // produce could never be delivered. Stay idle until a centre stands
                // (onTownCenterBuilt re-staffs the fields the moment one does).
                if (!buildings.some(b => b.type === 'town_center' && !b.underConstruction && b.health > 0)) return;
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
                    // targetX/Z is already this unit's SLOT; the lane aim only decides
                    // the route to it. Without a formation the aim is the slot itself,
                    // which is the straight line this has always walked.
                    const aim = this.formationAim(unit, unit.targetX, unit.targetZ);
                    const adx = aim.x - unit.x, adz = aim.z - unit.z;
                    const adist = Math.sqrt(adx * adx + adz * adz) || 1;
                    const moveSpeed = this.moveSpeedOf(unit, deltaTime) * deltaTime / 1000 * 3;
                    unit.x += (adx / adist) * moveSpeed;
                    unit.z += (adz / adist) * moveSpeed;
                    this.renderer.updateUnitPosition(unit);
                } else {
                    // Arrived at target - stop moving
                    unit.isMoving = false;
                    unit.x = unit.targetX;
                    unit.z = unit.targetZ;
                    unit.formationAxis = null;   // march over
                    unit.formationCatchup = 0;    // ...and so does any debt it owed
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
    
    // The worker actually WORKING this farm, or null — the ONE place "is this farm
    // manned" is decided. updateFarmRegeneration gates regen on it and the LLM game
    // state reports it, so the two can never drift apart and tell a model its farm
    // is fine while it quietly grows nothing. assignedWorker alone is not enough:
    // the hand may since have been pulled onto a resource by assign_workers,
    // drafted to fight, or killed — and a farm with a deserted post feeds no one.
    farmFarmer(farm) {
        if (!farm || farm.type !== 'farm' || farm.underConstruction || farm.health <= 0) return null;
        const w = farm.assignedWorker;
        if (!w || w.health <= 0) return null;
        if (w.task !== 'farm_work' && w.task !== 'carrying') return null;
        if (w.farmRef !== farm) return null;
        return w;
    }

    updateFarmRegeneration(deltaTime) {
        // Farms regenerate food over time, but only if a worker is assigned
        const farms = this.getAllBuildings().filter(b => b.type === 'farm' && !b.underConstruction);
        farms.forEach(farm => {
            if (!farm.regenTimer) farm.regenTimer = 0;

            // Post deserted (pulled away, drafted, or dead)? Drop the stale claim so
            // the farm reads as unmanned EVERYWHERE, and grow nothing.
            const worker = this.farmFarmer(farm);
            if (!worker) {
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
            progressText.textContent = t('hud.ageUpProgress', { pct: percentage });
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
            progressText.textContent = t('hud.researchProgress', { name: tech ? tg(tech.name) : '…', pct: percentage });
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
            progressText.textContent = t('hud.productionProgress', { pct: percentage });
        } else {
            progressBar.style.display = 'none';
        }
    }
    
    // A-G / 1-7 in the gutters beside the minimap, so "explore C5" in the decision
    // log can be found on the map without counting squares.
    //
    // The labels are read back OUT of tileLabelAt at each tile's centre instead of
    // being regenerated from 65+i. Same result today, but tileLabelAt is what the
    // models are actually given — deriving from it means the gutter cannot come to
    // disagree with the grid, whatever happens to EXPLORE_TILES or the map size.
    buildMinimapGutters() {
        const cols = document.getElementById('mmCols');
        const rows = document.getElementById('mmRows');
        if (!cols || !rows || cols.childElementCount) return;   // built once
        const T = this.EXPLORE_TILES || 7;
        const size = (this.terrain && this.terrain.size) || 800;
        const centre = i => -(size / 2) + (i + 0.5) * (size / T);
        for (let i = 0; i < T; i++) {
            const c = document.createElement('span');
            c.textContent = (this.tileLabelAt(centre(i), 0).match(/^[A-Z]+/) || [''])[0];
            cols.appendChild(c);
            const r = document.createElement('span');
            r.textContent = this.tileLabelAt(0, centre(i)).replace(/^[A-Z]+/, '');
            rows.appendChild(r);
        }
    }

    // ---- Spectator viewing aid: ONE seat's map knowledge, as a fog grid -------
    //
    // Returns the same 0/1/2 grid the human fog uses (0 never found, 1 found once,
    // 2 in sight right now) at fogOfWar's resolution, but for a single AI seat.
    // Purely a way to LOOK at the match: nothing here is written back, no model's
    // state reads it, nothing recorded changes. The seats play on unaware.
    //
    // It takes TWO sources, because neither one alone is what a seat has found:
    //
    //   tier 2 — computeAIFogGrid, which sweeps vision around living units and
    //     FINISHED buildings. That is all it does: measured on a running match it
    //     writes 713 twos and, by construction, not one single 1. Drawn from it
    //     alone the map goes black the instant a scout walks on, which is the
    //     opposite of "what this model has found".
    //
    //   tier 1 — FogOfWarManager.seatExplored(seat), "ground this seat has ever
    //     seen", accumulated by the very same 500ms sweep that builds the union
    //     fog drawn beside it, at the very same resolution.
    //
    // That last part is the whole point. This first read tier 1 off _explored, the
    // coarse bitmap markExploration keeps for every seat — which is the honest
    // discovery record and is what map.exploration is summed out of, but is 42
    // cells a side against this fog's 400, about nineteen world units each. Drawn
    // at map scale a scout's thin trail came out as a column of squares next to a
    // union view of the identical ground that was smooth. Same sweep, same grid,
    // same shapes: the solo view now differs from the union only in whose sweep it
    // counted, which is the one thing it is supposed to be saying.
    seatDiscoveryGrid(seat) {
        const fow = this.fogOfWar;
        const om = this.openAIAIManager;
        if (!fow || !om || !this.aiManager) return null;
        const ai = (this.aiManager.aiPlayers || []).find(a => a.seat === seat);
        if (!ai) return null;

        // No cache, and no reuse of a per-turn copy. Measured at the real 800 map
        // size: 0.04ms opening game, 0.23ms at 60 units and 6 towers, 0.59ms with
        // 200 units — against the 1.05ms updateMinimap already spends on the redraw
        // that consumes it, twice a second. Caching this would buy a fifth of a
        // millisecond and pay for it in staleness.
        const N = fow.numTiles;
        const grid = om.computeAIFogGrid(ai, this, N);

        const seen = fow.seatExplored(seat);
        if (seen && seen.length === grid.length) {
            // Never over-write a 2: in sight now outranks seen once.
            for (let i = 0; i < grid.length; i++) if (grid[i] === 0 && seen[i]) grid[i] = 1;
        }
        return grid;
    }

    updateMinimap() {
        this.buildMinimapGutters();
        const canvas = document.getElementById('minimapCanvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 300;
        canvas.height = 300;

        const terrainData = this.terrain.getMinimapData();
        const scale = 300 / terrainData.size;

        // WHOSE fog. Null (the default) is every seat's put together -- which is
        // already what the spectator's own fogGrid accumulates, since updateFog
        // reveals around every player in spectator mode. A seat number is one of the
        // knobs beside the minimap held down: draw that seat's discovery alone.
        const soloGrid = (this.minimapFogSeat != null) ? this.seatDiscoveryGrid(this.minimapFogSeat) : null;

        // "Has the viewer found this?" for every dot drawn below -- the same >= 1
        // test isPositionVisible makes, asked of whichever grid is in force. Kept as
        // one closure so a solo view can never hide the ground and then draw a rival
        // standing on it.
        const known = (() => {
            if (!this.fogOfWar) return () => true;
            if (!soloGrid) return (x, z) => this.fogOfWar.isPositionVisible(x, z);
            const N = this.fogOfWar.numTiles, cell = this.fogOfWar.gridSize;
            const half = terrainData.size / 2;
            return (x, z) => {
                const gx = Math.floor((x + half) / cell), gz = Math.floor((z + half) / cell);
                if (gx < 0 || gx >= N || gz < 0 || gz >= N) return false;
                return soloGrid[gz * N + gx] >= 1;
            };
        })();

        // WHOSE fog you are looking at, said on the map itself rather than only by
        // which knob is pressed: the found-but-not-watched band wears that seat's
        // badge colour, and the panel gets a frame in it.
        //
        // The colour is scaled to the dim tier's own brightness before it is mixed
        // in, so only the HUE moves. A raw wash of white (seat 1) or yellow (seat 6)
        // would come out brighter than the ground it veils and read as lit -- and
        // lit-vs-veiled is the one distinction the fog exists to make. The frame is
        // there for the same reason from the other side: at equal brightness white
        // is a weak wash, and a 3px border in it is not.
        //
        // tintA stays 0 in the default view, where the arithmetic below collapses to
        // exactly the multiply this has always done.
        let tintR = 0, tintG = 0, tintB = 0, tintA = 0, soloFrame = null;
        if (soloGrid && typeof getTeamBadge === 'function') {
            const badge = getTeamBadge(this.minimapFogSeat);
            if (badge && badge.fill) {
                const h = badge.fill.replace('#', '');
                let r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
                soloFrame = badge.fill;
                const lum = (0.299 * r + 0.587 * g + 0.114 * b) || 1;
                const k = Math.min(1, 96 / lum);       // ~the dim tier's own luminance
                tintR = r * k; tintG = g * k; tintB = b * k;
                tintA = 0.5;
            }
        }

        // Themed ground color (summer/winter/desert), tuned so every node color
        // keeps contrast: wood #228B22, stone #808080, gold #FFD700, food #8B4513.
        const MINIMAP_GROUND = { easy: '#4a8c3f', medium: '#5c7480', hard: '#8f7448' };
        ctx.fillStyle = MINIMAP_GROUND[this.terrain.difficulty] || MINIMAP_GROUND.easy;
        ctx.fillRect(0, 0, 300, 300);

        // Draw fog of war overlay FIRST (so resources appear on top)
        if (this.fogOfWar) {
            const fogGrid = soloGrid || this.fogOfWar.fogGrid;
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
                        // Explored but not visible - dim the bright green to dark green (matches playing field),
                        // then pull it toward the soloed seat's colour (tintA is 0 by default).
                        const dr = data[pixelIdx] * 0.7;
                        const dg = data[pixelIdx + 1] * 0.7;
                        const db = data[pixelIdx + 2] * 0.7;
                        data[pixelIdx] = Math.floor(dr + (tintR - dr) * tintA);
                        data[pixelIdx + 1] = Math.floor(dg + (tintG - dg) * tintA);
                        data[pixelIdx + 2] = Math.floor(db + (tintB - db) * tintA);
                        data[pixelIdx + 3] = 255;
                    }
                    // fogValue === 2 (visible) - leave pixel unchanged (bright green)
                }
            }
            
            ctx.putImageData(imageData, 0, 0);
        }

        // The 7x7 explore grid. Drawn over the ground but UNDER the entities, so a
        // unit dot is never crossed by a line — the grid is a reference, not a reading.
        // Interior lines only; the panel border already closes the outside.
        const gridT = this.EXPLORE_TILES || 7;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.17)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i < gridT; i++) {
            // +0.5 so a 1px line lands on a pixel instead of straddling two and
            // smearing into a soft 2px band.
            const at = Math.round((i * 300) / gridT) + 0.5;
            ctx.moveTo(at, 0); ctx.lineTo(at, 300);
            ctx.moveTo(0, at); ctx.lineTo(300, at);
        }
        ctx.stroke();
        ctx.restore();

        // Draw resources (only in explored/visible areas) - drawn AFTER fog so they stay visible
        terrainData.resources.forEach(resource => {
            if (resource.amount !== undefined && resource.amount <= 0) return; // depleted
            const x = (resource.x + terrainData.size / 2) * scale;
            const z = (resource.z + terrainData.size / 2) * scale;

            // Only draw resources within minimap bounds
            if (x < 0 || x > 300 || z < 0 || z > 300) return;
            
            // Check fog of war - only show resources in explored areas
            if (!known(resource.x, resource.z)) return;
            
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
        // The minimap speaks the WORLD's color language: every owner draws in
        // its civilization color. Player dots used to be a hardcoded blue —
        // Greece's blue — no matter which civ the human actually played.
        if (!this.spectatorMode) {
            const myCiv = getCivilization(this.player.civilization);
            const myColor = '#' + ((myCiv && myCiv.color) || 0x4ecca3).toString(16).padStart(6, '0');
            this.player.buildings.forEach(building => {
                const x = (building.x + terrainData.size / 2) * scale;
                const z = (building.z + terrainData.size / 2) * scale;
                ctx.fillStyle = myColor;
                ctx.fillRect(x - 3, z - 3, 6, 6);
            });

            // Draw player units (only in visible areas)
            this.player.units.forEach(unit => {
                const x = (unit.x + terrainData.size / 2) * scale;
                const z = (unit.z + terrainData.size / 2) * scale;
                ctx.fillStyle = myColor;
                ctx.fillRect(x - 2, z - 2, 4, 4);
            });
        }

        // Draw AI players (only in visible areas) — always their civ color,
        // matching the world view's team tints in campaign AND spectator mode.
        this.aiManager.aiPlayers.forEach(ai => {
            const civ = getCivilization(ai.civilization);
            const colorHex = '#' + (civ?.color || 0xff0000).toString(16).padStart(6, '0');
            const unitColor = colorHex;
            const buildingColor = colorHex;

            ai.buildings.forEach(building => {
                if (!known(building.x, building.z)) return;
                const x = (building.x + terrainData.size / 2) * scale;
                const z = (building.z + terrainData.size / 2) * scale;
                ctx.fillStyle = buildingColor;
                ctx.fillRect(x - 3, z - 3, 6, 6);
            });

            ai.units.forEach(unit => {
                if (!known(unit.x, unit.z)) return;
                const x = (unit.x + terrainData.size / 2) * scale;
                const z = (unit.z + terrainData.size / 2) * scale;
                ctx.fillStyle = unitColor;
                ctx.fillRect(x - 2, z - 2, 4, 4);
            });
        });

        // Combat pings on top: pulsing red rings where damage landed recently,
        // so a spectator glancing at the minimap never misses a fight.
        if (this._combatPings && this._combatPings.length) {
            const now = Date.now();
            this._combatPings = this._combatPings.filter(p => p.until > now);
            const pulse = 2.5 + Math.sin(now / 120) * 1.5;
            ctx.strokeStyle = 'rgba(255, 70, 40, 0.9)';
            ctx.lineWidth = 1.5;
            this._combatPings.forEach(p => {
                // A solo view that blacks out the ground must not ring a fight on
                // it: this seat has not found that place, so it has not seen this.
                if (!known(p.x, p.z)) return;
                const x = (p.x + terrainData.size / 2) * scale;
                const z = (p.z + terrainData.size / 2) * scale;
                ctx.beginPath();
                ctx.arc(x, z, pulse, 0, Math.PI * 2);
                ctx.stroke();
            });
        }

        // Last, over everything: the soloed seat's colour around the edge.
        if (soloFrame) {
            ctx.save();
            ctx.strokeStyle = soloFrame;
            ctx.lineWidth = 3;
            ctx.strokeRect(1.5, 1.5, 297, 297);
            ctx.restore();
        }
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
            const required = (this.wonderRequired || 600) * 1000;
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

        // Check if all AI players are defeated — SAME elimination rule as the arena
        // (isPlayerEliminated: no army, no affordable military production, no TC and
        // no way to rebuild one). Previously campaign required razing every last
        // unit/building, so games dragged on hunting one fleeing worker while the
        // identical board state would already have ended an arena match.
        const activeAI = this.aiManager.aiPlayers.filter(ai => !this.isPlayerEliminated(ai));

        if (activeAI.length === 0 && this.aiManager.aiPlayers.length > 0) {
            this.ui.showVictory();
            this.gameStarted = false;
            return;
        }

        // Check if player is defeated (skip in spectator mode) — same rule.
        if (!this.spectatorMode && this.isPlayerEliminated(this.player)) {
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
                const def = (typeof getUnitDefFor === 'function') ? getUnitDefFor(ai.civilization, uid) : null;
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
        const required = (this.wonderRequired || 600) * 1000;
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
        // Ask whoever is still standing for a closing statement BEFORE stop(), which
        // aborts every controller's in-flight request. The question carries its own
        // abort handle so it survives that, but firing first keeps the order honest:
        // the last thing asked of a model is asked while the match is still its match.
        // Fire-and-forget — the summary must not wait on an endpoint, and the recorder
        // files a late reply in the right place regardless.
        // Declared up here rather than beside finish(), where it used to live, because
        // the progress callback below reads it and collectFinalWords fires that callback
        // synchronously for the opening (0, n). From further down `ended` would still be
        // in its temporal dead zone at that moment, the read would throw into a catch
        // that swallows it, and the wait card would never appear at all.
        let ended = false;
        let pending = null;
        if (this.openAIAIManager && this.openAIAIManager.collectFinalWords) {
            try {
                pending = this.openAIAIManager.collectFinalWords(reason, winnerAi,
                    (done, total) => {
                        // Skipping aborts the questions, and every abort settles a tick
                        // LATER, counting itself done on the way out. Those late ticks
                        // used to rebuild the wait card on top of the summary the skip
                        // had just put up -- rebuilt holding a button wired to
                        // _skipFinalWords, which finish() had set to null a moment
                        // before. A full-screen overlay at z-index 9000 whose only
                        // control did nothing: the match was over, the results were
                        // right there behind it, and the screen could not be dismissed.
                        if (ended) return;
                        if (this.ui.finalWordsProgress) this.ui.finalWordsProgress(done, total);
                    });
            } catch (e) { console.warn('[arena] final words failed', e); }
        }
        // Halt the LLM pipeline so finished-match requests stop spending quota and
        // can't spawn late units into the scene behind the summary. The closing
        // questions carry their own abort handle and survive this.
        if (this.openAIAIManager) this.openAIAIManager.stop();

        // Guarded: the wait can now end two ways -- the answers arriving, or somebody
        // giving up on them -- and both must not run the ending twice. (`ended` is
        // declared above, where the progress callback can see it.)
        const finish = () => {
            if (ended) return;
            ended = true;
            this._skipFinalWords = null;
            if (this.ui.hideFinalWordsWait) this.ui.hideFinalWordsWait();
            if (this.ui.teardownSpectatorUI) this.ui.teardownSpectatorUI();
            this.ui.showArenaSummary(winnerAi, reason);
        };
        // The way out. A match ended on purpose is worth the wait; a match ended BECAUSE
        // an endpoint is broken is not, and there the wait is spent on the very thing
        // that failed. Aborts the questions rather than only hiding the note, so nothing
        // keeps running behind the summary.
        this._skipFinalWords = () => {
            try {
                if (this.openAIAIManager && this.openAIAIManager.cancelFinalWords) {
                    this.openAIAIManager.cancelFinalWords();
                }
            } catch (e) { console.warn('[arena] could not cancel final words', e); }
            finish();
        };
        // This used to be fire-and-forget, with the summary up before a single answer
        // was back. Every closing statement takes an endpoint round trip, and a wonder
        // ending asks EVERY seat at once -- so a match that ended that way recorded one
        // reply out of three, the winner's among the missing, and whoever downloaded the
        // transcript promptly got a hole where the best part of the record should be.
        //
        // So: wait. The board stays up behind a note saying what is being waited for,
        // because a screen that looks finished and does not move reads as a hang. Bounded
        // by askFinalWord's own 60s timeout, so a dead endpoint cannot stall the summary.
        if (pending && typeof pending.then === 'function') {
            pending.catch(() => null).then(finish);
            return;
        }
        finish();
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

// A copy served from somewhere else is a SHOWCASE, not an installation.
//
// The analyzer needs no API key and no endpoint -- it reads a file -- which makes it the
// one part of this project that is safe to hand a stranger. The arena and the campaign
// are not: they ask for keys, and a key pasted into a page someone else controls is a
// different proposition from one pasted into a page you are serving yourself, even
// though both only ever keep it in your own browser. So a hosted copy opens straight
// into the analyzer with the bundled match and offers no route to the rest.
//
// The rule is where the page came FROM, not who is looking: served off your own network
// you get everything, served from the public internet you get the showcase. ?full=1 opts
// back in.
//
// It used to be loopback only, which made the tablet in the same room a stranger: serving
// on 192.168.x and opening it from the sofa dropped you into the analyzer with no way to
// start a match. That is a configuration people actually run, and the address it comes
// from is one they own.
//
// What this can and cannot check. The honest test would be "same subnet as the device I
// am holding", but a page only ever sees the address it was SERVED from, never the
// client's own -- WebRTC candidate discovery, the old way of learning it, returns mDNS
// .local placeholders in every current browser. So the test is whether the host is
// private at all: RFC1918, loopback, link-local, IPv6 ULA, an mDNS name, or a
// single-label hostname. None of those are routable from outside.
//
// Parsed as an address rather than matched as a prefix, which matters more than it looks.
// /^192\.168\./ against a hostname also accepts 192.168.1.1.evil.com -- a legal, public,
// resolvable domain -- and would have handed the full app to anyone who registered one.
// An IPv4 literal is therefore matched whole and then judged by its octets, and anything
// that is not a literal has to earn "private" some other way.
//
// Wider than one subnet by exactly the amount that matters: a hostile LAN you did not set
// up -- cafe wifi, a hotel -- could serve a page from a private address and would now
// open the key fields. It still cannot read a key back out; the risk is a page you were
// persuaded to visit AND paste into. Judged worth it against a real configuration being
// locked out, and the case this was built for is unchanged -- github.io is a public name
// with no private form, so it stays a showcase.
const WAR_PRIVATE_HOST = (() => {
    const h = (location.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!h) return false;
    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const o = v4.slice(1).map(Number);
        if (o.some(n => n > 255)) return false;          // not an address at all
        if (o[0] === 127) return true;                   // loopback
        if (o[0] === 10) return true;                    // 10/8
        if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;   // 172.16/12
        if (o[0] === 192 && o[1] === 168) return true;   // 192.168/16
        if (o[0] === 169 && o[1] === 254) return true;   // link-local
        return false;                                    // every other literal is public
    }
    if (h.indexOf(':') >= 0) {                           // IPv6 literal (DNS names have no colon)
        if (h === '::1') return true;                    // loopback
        if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;  // unique local, fc00::/7
        if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;   // link-local, fe80::/10
        return false;
    }
    if (h === 'localhost' || /\.localhost$/.test(h)) return true;
    if (/\.local$/.test(h)) return true;                  // mDNS / Bonjour
    if (/^[a-z0-9-]+$/.test(h)) return true;             // single-label name: cannot be public
    return false;
})();
const WAR_LOCAL = location.protocol === 'file:' || WAR_PRIVATE_HOST;
const WAR_DEMO_ONLY = !WAR_LOCAL && !/[?&]full=1(&|$)/.test(location.search);

// A renderer that cannot be built used to throw out of here and stop, leaving a page
// that LOOKED fine: the menus are DOM and kept working, so the app invited a match it
// could never draw. Pressing Start then walked into null.clearScene, which is what the
// report "the normal player UI appears and then nothing happens" actually was.
//
// The engine asks for plain WebGL 1, so a machine without it usually has hardware
// acceleration switched off, a blocklisted driver, or no GPU at all (a remote desktop
// session is the classic). None of that is something the page can fix -- but it can say
// so, instead of pretending and failing later.
function warNoWebGL(e) {
    console.error('[boot] renderer unavailable', e);
    const box = document.createElement('div');
    box.className = 'boot-error';
    const p1 = document.createElement('p');
    p1.textContent = t('boot.noWebGL');
    const p2 = document.createElement('p');
    p2.className = 'boot-why';
    p2.textContent = t('boot.noWebGLWhy');
    box.appendChild(p1); box.appendChild(p2);
    document.body.appendChild(box);
    document.body.classList.add('boot-failed');
}

window.addEventListener('load', () => {
    game = new Game();
    try {
        game.init();
    } catch (e) {
        // Only the machine's fault is handled here. Anything else is a bug in the game
        // and must keep its stack rather than be dressed up as a hardware notice.
        if (e && e.noWebGL) { warNoWebGL(e); return; }
        throw e;
    }
    if (WAR_DEMO_ONLY) {
        document.body.classList.add('demo-only');
        game.ui.anOpen();
        game.ui.anLoadSample();
    }
});
