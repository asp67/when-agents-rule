// Fog of War system: the fog's DATA. The grid of what has been seen, who reveals it,
// and what that hides. How the fog LOOKS -- its colours, its soft edge, the canvases the
// renderer uploads -- is js/fog-display.js (build 1188), which is not a rule file and
// adds initDisplay / paintFog / dropDisplay to this class. Without it (a bare VM, a
// worker replaying a match) the fog is kept exactly the same and simply never drawn.
class FogOfWarManager {
    constructor(game) {
        this.game = game;
        this.renderer = game.renderer;

        // Grid settings
        this.gridSize = 2; // Size of each fog cell
        this.mapSize = game.terrain.size;
        this.numTiles = this.mapSize / this.gridSize;

        // Visibility range
        this.unitVisionRange = 15;
        this.buildingVisionRange = 12;
        this.towerVisionRange = 60; // tripled — towers are long-range sentinels

        // Fog grid: 0 = unexplored (black), 1 = explored (dark), 2 = visible (clear)
        this.fogGrid = new Float32Array(this.numTiles * this.numTiles);
        this.fogGrid.fill(0); // Start with all unexplored

        this.fogDirty = false; // the display's re-upload signal to the renderer

        // Update timer
        this.updateTimer = 0;
        this.updateInterval = 500; // Update fog every 500ms

        this.init();
    }

    init() {
        if (this.initDisplay) this.initDisplay();   // the picture's canvases (js/fog-display.js)
        // Initialize fog texture + hide resources that start unexplored
        this.updateFogTexture();
        this.applyResourceVisibility();
    }
    
    // Get grid coordinates from world position
    getGridCoords(x, z) {
        const halfSize = this.mapSize / 2;
        const gx = Math.floor((x + halfSize) / this.gridSize);
        const gz = Math.floor((z + halfSize) / this.gridSize);
        return { gx: Math.max(0, Math.min(this.numTiles - 1, gx)), gz: Math.max(0, Math.min(this.numTiles - 1, gz)) };
    }
    
    // Get world position from grid coordinates
    getWorldPosition(gx, gz) {
        const halfSize = this.mapSize / 2;
        return {
            x: gx * this.gridSize - halfSize + this.gridSize / 2,
            z: gz * this.gridSize - halfSize + this.gridSize / 2
        };
    }
    
    // Reveal fog around a position
    reveal(x, z, range) {
        // Mark as visible (2) - this also marks as explored
        this.revealInto(this.fogGrid, x, z, range, 2);
    }

    // The same disc, written into ANY grid of this fog's shape. reveal() is this
    // against the manager's own fogGrid; the spectator's per-seat records are the
    // identical geometry kept somewhere else. ONE copy of the circle walk, so a
    // solo view and the union view can never come to disagree about what a scout
    // actually swept -- which is the whole claim the solo view is making.
    revealInto(grid, x, z, range, value) {
        if (!grid) return;
        const { gx, gz } = this.getGridCoords(x, z);
        const gridRange = Math.ceil(range / this.gridSize);

        for (let dx = -gridRange; dx <= gridRange; dx++) {
            for (let dz = -gridRange; dz <= gridRange; dz++) {
                const nx = gx + dx;
                const nz = gz + dz;

                if (nx < 0 || nx >= this.numTiles || nz < 0 || nz >= this.numTiles) continue;

                // Check if within range
                const dist = Math.sqrt(dx * dx + dz * dz) * this.gridSize;
                if (dist > range) continue;

                const idx = nz * this.numTiles + nx;
                if (grid[idx] < value) grid[idx] = value;
            }
        }
    }

    // ---- Per-seat discovery, spectator viewing aid ---------------------------
    // "Ground this seat has ever seen", at THIS fog's resolution, accumulated by
    // the same sweep that builds the union fog beside it. Never decays: unlike the
    // union's tier 2 this is a record, not a state.
    //
    // It exists because the coarse record the game already keeps -- _explored, 42
    // cells a side against this grid's 400 -- is far too blocky to draw. It is the
    // right size for what it is FOR (a 7x7 percentage the models read), and about
    // nineteen world units per cell, which turned a scout's thin trail into a
    // column of squares the moment it was drawn at map scale.
    //
    // Spectator-only, and allocated per seat on first use, so a campaign never
    // pays for it -- nothing calls this outside the spectator branch of updateFog.
    seatExplored(seat) {
        if (seat == null || seat < 0) return null;
        if (!this._seatExplored) this._seatExplored = new Map();
        let g = this._seatExplored.get(seat);
        if (!g || g.length !== this.numTiles * this.numTiles) {
            g = new Uint8Array(this.numTiles * this.numTiles);
            this._seatExplored.set(seat, g);
        }
        return g;
    }
    
    // Update fog state
    update(deltaTime) {
        this.updateTimer += deltaTime;
        
        if (this.updateTimer >= this.updateInterval) {
            this.updateTimer = 0;
            this.updateFog();
        }
    }
    
    // Update fog visibility
    updateFog() {
        // First, mark all visible cells as explored (not visible)
        for (let i = 0; i < this.fogGrid.length; i++) {
            if (this.fogGrid[i] === 2) {
                this.fogGrid[i] = 1; // Was visible, now just explored
            }
        }
        
        // Reveal fog around player units (game.unitVision: cavalry sees 50% farther)
        this.game.player.units.forEach(unit => {
            this.reveal(unit.x, unit.z, this.game.unitVision(unit));
            if (unit.watch) for (const c of this.game.towerWatchCircles(unit)) this.reveal(c.x, c.z, c.r);
        });
        
        // Reveal fog around player buildings. Construction plots grant NOTHING —
        // scaffolding doesn't see; the tower's 60-radius sweep switches on only
        // when the build completes (the builders' own unit vision covers the
        // site while they work).
        this.game.player.buildings.forEach(building => {
            if (building.underConstruction) return;
            for (const c of this.game.buildingSightCircles(building)) this.reveal(c.x, c.z, c.r);
        });

        // In spectator mode, also reveal fog around ALL AI units and buildings
        // so the spectator sees everything any player can see
        if (this.game.spectatorMode && this.game.aiManager) {
            this.game.aiManager.aiPlayers.forEach(ai => {
                // ...and, on the same sweep, into that seat's OWN record, which the
                // minimap draws when a fog knob is pressed. Marked 1, not 2: this one
                // is "has ever seen", and what a seat sees right NOW is computed live
                // at draw time. Same disc, same grid size, so the solo view and the
                // union view are the same shapes.
                const own = this.seatExplored(ai.seat);
                ai.units.forEach(unit => {
                    const range = this.game.unitVision(unit);
                    this.reveal(unit.x, unit.z, range);
                    this.revealInto(own, unit.x, unit.z, range, 1);
                    if (unit.watch) for (const c of this.game.towerWatchCircles(unit)) {
                        this.reveal(c.x, c.z, c.r);
                        this.revealInto(own, c.x, c.z, c.r, 1);
                    }
                });
                ai.buildings.forEach(building => {
                    if (building.underConstruction) return; // plots don't see (same rule as the player's)
                    for (const c of this.game.buildingSightCircles(building)) {
                        this.reveal(c.x, c.z, c.r);
                        this.revealInto(own, c.x, c.z, c.r, 1);
                    }
                });
            });
        }
        
        // Update fog texture
        this.updateFogTexture();
        
        // Update visibility of enemy units and buildings
        this.updateEntityVisibility();
    }
    
    // The grid changed (or a caller filled it): count the change, and have the picture
    // redrawn where there is one.
    updateFogTexture() {
        this.visibilityVersion = (this.visibilityVersion || 0) + 1;
        if (this.paintFog) this.paintFog();
    }

    // Hide resource nodes (trees, animals, stone, gold) until their tile is explored.
    applyResourceVisibility() {
        if (!this.game.terrain || !this.game.terrain.resources) return;
        this.game.terrain.resources.forEach(resource => {
            const revealed = this.isPositionVisible(resource.x, resource.z);
            if (!resource.mesh) return;
            if (resource.mesh.trunk) {
                resource.mesh.trunk.visible = revealed;
                resource.mesh.leaves.visible = revealed;
            } else {
                resource.mesh.visible = revealed;
            }
        });
    }

    // Update visibility of enemy entities
    updateEntityVisibility() {
        // In spectator mode, units/buildings stay visible (you watch everyone),
        // but resources are still concealed until a player has scouted them.
        if (this.game.spectatorMode) {
            this.game.renderer.units.forEach(unit => {
                if (unit.mesh) unit.mesh.visible = true;
            });
            this.game.renderer.buildings.forEach(building => {
                if (building.mesh) building.mesh.visible = true;
            });
            this.applyResourceVisibility();
            return;
        }

        // Check each enemy unit
        this.game.renderer.units.forEach(unit => {
            if (unit.owner === 'player') return; // Player units always visible
            
            const isVisible = this.isPositionVisible(unit.x, unit.z);
            if (unit.mesh) {
                unit.mesh.visible = isVisible;
            }
        });
        
        // Check each enemy building
        this.game.renderer.buildings.forEach(building => {
            if (building.owner === 'player') return; // Player buildings always visible
            
            // An unstarted enemy trebuchet site is unseen (b1110).
            const isVisible = this.isPositionVisible(building.x, building.z) && !Game.hiddenSite(building);
            if (building.mesh) {
                building.mesh.visible = isVisible;
            }
        });
        
        // Resource nodes (hidden until explored)
        this.applyResourceVisibility();
    }
    
    // Check if a position is visible
    isPositionVisible(x, z) {
        const { gx, gz } = this.getGridCoords(x, z);
        const idx = gz * this.numTiles + gx;
        return this.fogGrid[idx] >= 1; // Visible or explored
    }
    
    // Check if a position is currently visible (not just explored)
    isPositionCurrentlyVisible(x, z) {
        const { gx, gz } = this.getGridCoords(x, z);
        const idx = gz * this.numTiles + gx;
        return this.fogGrid[idx] === 2;
    }
    
    // Reveal fog around player's starting position
    revealStartingArea() {
        // Reveal around player's town center
        const townCenter = this.game.player.buildings.find(b => b.type === 'town_center');
        if (townCenter) {
            this.reveal(townCenter.x, townCenter.z, this.game.buildingVision(townCenter) * 1.5);
        }
        
        // Reveal around player's units
        this.game.player.units.forEach(unit => {
            this.reveal(unit.x, unit.z, this.unitVisionRange * 1.5);
        });
    }

    // Tear down the fog overlay so a new game doesn't layer stale state over a
    // fresh one. Dropping the display's canvases is enough: the renderer keys its
    // fog texture on the canvas identity and rebuilds for the next manager.
    destroy() {
        if (this.dropDisplay) this.dropDisplay();
        this.fogDirty = false;
    }
}
