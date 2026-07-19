// Fog of War system. Since the in-house engine (M6) this class owns only the
// fog DATA and its canvases: the grid, the blur-upscaled display canvas, and a
// `fogDirty` flag. EngineRenderer uploads the display canvas as a texture on
// its fog plane whenever the flag is set (and clears it).
class FogOfWarManager {
    // How far the reveal edge feathers, in WORLD units. Against a 15-unit unit
    // vision radius this is the difference between fog that is lit and fog that
    // is cut out with scissors.
    static get FEATHER_WORLD() { return 5; }

    // How far the fog reaches PAST the map, and the width it fades out over. The
    // plane used to be exactly mapSize, so it stopped dead at ±400 while the coast
    // runs out to ~416 — a hard square cut across the beach, fogged land on the
    // inside and fully lit shore on the outside. Fading BEYOND the map rather than
    // inside it means no part of the playable area trades fog integrity for the
    // effect: units clamp to ~396 and resources are seeded inside 360, so
    // everything past 400 is shoreline and open water.
    static get EDGE_MARGIN_WORLD() { return 60; }

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
        // ...and a margin of edge-extended cells around it, so the fog can fade out
        // past the map instead of being cut off at it. Composed at CELL resolution
        // first: blurring each of the nine pieces separately would fade every
        // piece's own border and seam the margin, so the whole thing is assembled
        // unblurred and then blur-upscaled in one pass.
        this._marginCells = Math.round(FogOfWarManager.EDGE_MARGIN_WORLD / this.gridSize);
        this.displayWorldSize = this.mapSize + 2 * FogOfWarManager.EDGE_MARGIN_WORLD;
        const cells = this.numTiles + 2 * this._marginCells;
        this._scratchCanvas = document.createElement('canvas');
        this._scratchCanvas.width = this._scratchCanvas.height = cells;
        this._scratchCtx = this._scratchCanvas.getContext('2d');

        this.fogDisplayCanvas = document.createElement('canvas');
        this.fogDisplayCanvas.width = cells * 4;
        this.fogDisplayCanvas.height = cells * 4;
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
        const src = this.fogCanvas, sw = src.width, sh = src.height;
        const M = this._marginCells, S = this._scratchCanvas.width;
        const s = this._scratchCtx;
        // Compose grid + margin at cell resolution. The margin is the border row /
        // column STRETCHED outward: a uniformly dark margin would ring explored
        // coastline in shadow, and a clear one would cut back the same hard square
        // this exists to remove. Extending means the fog simply keeps saying
        // whatever the map's edge said, then stops mattering.
        s.save();
        s.imageSmoothingEnabled = false;
        s.clearRect(0, 0, S, S);
        s.drawImage(src, 0, 0, sw, sh, M, M, sw, sh);                       // the map
        s.drawImage(src, 0, 0, sw, 1, M, 0, sw, M);                         // top
        s.drawImage(src, 0, sh - 1, sw, 1, M, S - M, sw, M);                // bottom
        s.drawImage(src, 0, 0, 1, sh, 0, M, M, sh);                         // left
        s.drawImage(src, sw - 1, 0, 1, sh, S - M, M, M, sh);                // right
        s.drawImage(src, 0, 0, 1, 1, 0, 0, M, M);                           // corners
        s.drawImage(src, sw - 1, 0, 1, 1, S - M, 0, M, M);
        s.drawImage(src, 0, sh - 1, 1, 1, 0, S - M, M, M);
        s.drawImage(src, sw - 1, sh - 1, 1, 1, S - M, S - M, M, M);
        s.restore();

        const d = this.fogDisplayCtx, W = this.fogDisplayCanvas.width;
        // The radius is stated in WORLD units and converted here, so changing
        // gridSize or the upscale can't silently change how soft the fog reads.
        // At a flat 3px it feathered barely 1.5 world units against a 15-unit
        // vision radius, which is why the reveal edge looked cut rather than lit.
        const pxPerWorld = W / this.displayWorldSize;
        const blurPx = Math.max(1, Math.round(FogOfWarManager.FEATHER_WORLD * pxPerWorld));
        d.save();
        d.clearRect(0, 0, W, W);
        d.imageSmoothingEnabled = true;
        try { d.filter = `blur(${blurPx}px)`; } catch (e) {}
        d.drawImage(this._scratchCanvas, 0, 0, W, W);
        // Then ramp the margin away, so the plane's own edge has nothing left to
        // show. Four linear gradients; the corners get both and so fade sooner,
        // which is what a corner should do anyway.
        try { d.filter = 'none'; } catch (e) {}
        d.globalCompositeOperation = 'destination-out';
        const m = Math.round(FogOfWarManager.EDGE_MARGIN_WORLD * pxPerWorld);
        const ramp = (x0, y0, x1, y1, rx, ry, rw, rh) => {
            const g = d.createLinearGradient(x0, y0, x1, y1);
            g.addColorStop(0, 'rgba(0,0,0,1)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            d.fillStyle = g;
            d.fillRect(rx, ry, rw, rh);
        };
        ramp(0, 0, m, 0, 0, 0, m, W);                 // left
        ramp(W, 0, W - m, 0, W - m, 0, m, W);         // right
        ramp(0, 0, 0, m, 0, 0, W, m);                 // top
        ramp(0, W, 0, W - m, 0, W - m, W, m);         // bottom
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
        this._scratchCanvas = null;
        this.fogDirty = false;
    }
}
