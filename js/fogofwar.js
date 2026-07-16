// Fog of War system. Since the in-house engine (M6) this class owns only the
// fog DATA and its canvases: the grid, the blur-upscaled display canvas, and a
// `fogDirty` flag. EngineRenderer uploads the display canvas as a texture on
// its fog plane whenever the flag is set (and clears it).
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

        this.fogCanvas = null;
        this.fogCtx = null;
        this.fogDirty = false; // renderer's re-upload signal

        // Update timer
        this.updateTimer = 0;
        this.updateInterval = 500; // Update fog every 500ms

        this.init();
    }

    init() {
        // Grid canvas: exact 1 texel per fog cell (the data, drawn by updateFogTexture)
        this.fogCanvas = document.createElement('canvas');
        this.fogCanvas.width = this.numTiles;
        this.fogCanvas.height = this.numTiles;
        this.fogCtx = this.fogCanvas.getContext('2d');

        // Display canvas: the grid blur-upscaled 4×. Sampling the tiny grid canvas
        // directly gave hard-edged blocky reveal squares — the ugliest thing on
        // screen while spectating. Feathering it here costs one blurred drawImage
        // every fog update (~2/s) and turns the reveals into soft fog lobes.
        this.fogDisplayCanvas = document.createElement('canvas');
        this.fogDisplayCanvas.width = this.numTiles * 4;
        this.fogDisplayCanvas.height = this.numTiles * 4;
        this.fogDisplayCtx = this.fogDisplayCanvas.getContext('2d');

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
                // Mark as visible (2) - this also marks as explored
                if (this.fogGrid[idx] < 2) {
                    this.fogGrid[idx] = 2;
                }
            }
        }
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
        });
        
        // Reveal fog around player buildings. Construction plots grant NOTHING —
        // scaffolding doesn't see; the tower's 60-radius sweep switches on only
        // when the build completes (the builders' own unit vision covers the
        // site while they work).
        this.game.player.buildings.forEach(building => {
            if (building.underConstruction) return;
            this.reveal(building.x, building.z, this.game.buildingVision(building));
        });

        // In spectator mode, also reveal fog around ALL AI units and buildings
        // so the spectator sees everything any player can see
        if (this.game.spectatorMode && this.game.aiManager) {
            this.game.aiManager.aiPlayers.forEach(ai => {
                ai.units.forEach(unit => {
                    this.reveal(unit.x, unit.z, this.game.unitVision(unit));
                });
                ai.buildings.forEach(building => {
                    if (building.underConstruction) return; // plots don't see (same rule as the player's)
                    this.reveal(building.x, building.z, this.game.buildingVision(building));
                });
            });
        }
        
        // Update fog texture
        this.updateFogTexture();
        
        // Update visibility of enemy units and buildings
        this.updateEntityVisibility();
    }
    
    // Update fog texture
    updateFogTexture() {
        const imageData = this.fogCtx.createImageData(this.numTiles, this.numTiles);
        const data = imageData.data;
        
        for (let i = 0; i < this.fogGrid.length; i++) {
            const idx = i * 4;
            const fogValue = this.fogGrid[i];
            
            if (fogValue === 0) {
                // Unexplored - misty dark gray (conceals the area until scouted)
                data[idx] = 46;     // R
                data[idx + 1] = 49; // G
                data[idx + 2] = 56; // B
                data[idx + 3] = 212; // Alpha (mostly opaque, but slightly misty)
            } else if (fogValue === 1) {
                // Explored but not currently visible - lighter gray haze
                data[idx] = 64;     // R
                data[idx + 1] = 68; // G
                data[idx + 2] = 76; // B
                data[idx + 3] = 110; // Alpha
            } else {
                // Visible - transparent
                data[idx] = 0;     // R
                data[idx + 1] = 0; // G
                data[idx + 2] = 0; // B
                data[idx + 3] = 0; // Alpha (fully transparent)
            }
        }
        
        this.fogCtx.putImageData(imageData, 0, 0);

        // Feather: blur-upscale the cell grid onto the display canvas. One display
        // cell is 4px, so a ~3px blur bleeds roughly three quarters of a cell —
        // soft fog edges instead of hard tile stairsteps. ctx.filter is supported
        // in every current browser; if it ever isn't, the smoothed upscale alone
        // still softens the blocks.
        const d = this.fogDisplayCtx;
        d.save();
        d.clearRect(0, 0, this.fogDisplayCanvas.width, this.fogDisplayCanvas.height);
        d.imageSmoothingEnabled = true;
        try { d.filter = 'blur(3px)'; } catch (e) {}
        d.drawImage(this.fogCanvas, 0, 0, this.fogDisplayCanvas.width, this.fogDisplayCanvas.height);
        d.restore();

        this.fogDirty = true; // renderer re-uploads the display canvas next frame
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
            
            const isVisible = this.isPositionVisible(building.x, building.z);
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
    // fresh one. Dropping the display canvas is enough: the renderer keys its
    // fog texture on the canvas identity and rebuilds for the next manager.
    destroy() {
        this.fogDisplayCanvas = null;
        this.fogCanvas = null;
        this.fogDirty = false;
    }
}
