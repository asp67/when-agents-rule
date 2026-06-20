// Fog of War system
class FogOfWarManager {
    constructor(game) {
        this.game = game;
        this.renderer = game.renderer;
        this.scene = game.renderer.scene;
        
        // Grid settings
        this.gridSize = 2; // Size of each fog cell
        this.mapSize = game.terrain.size;
        this.numTiles = this.mapSize / this.gridSize;
        
        // Visibility range
        this.unitVisionRange = 15;
        this.buildingVisionRange = 12;
        this.towerVisionRange = 20;
        
        // Fog grid: 0 = unexplored (black), 1 = explored (dark), 2 = visible (clear)
        this.fogGrid = new Float32Array(this.numTiles * this.numTiles);
        this.fogGrid.fill(0); // Start with all unexplored
        
        // Fog mesh
        this.fogMesh = null;
        this.fogTexture = null;
        this.fogCanvas = null;
        this.fogCtx = null;
        
        // Update timer
        this.updateTimer = 0;
        this.updateInterval = 500; // Update fog every 500ms
        
        this.init();
    }
    
    init() {
        // Create fog canvas and texture
        this.fogCanvas = document.createElement('canvas');
        this.fogCanvas.width = this.numTiles;
        this.fogCanvas.height = this.numTiles;
        this.fogCtx = this.fogCanvas.getContext('2d');
        
        this.fogTexture = new THREE.CanvasTexture(this.fogCanvas);
        this.fogTexture.magFilter = THREE.LinearFilter;
        this.fogTexture.minFilter = THREE.LinearFilter;
        
        // Create fog plane (slightly above ground)
        const fogGeometry = new THREE.PlaneGeometry(this.mapSize, this.mapSize);
        const fogMaterial = new THREE.MeshBasicMaterial({
            map: this.fogTexture,
            transparent: true,
            opacity: 1,
            depthWrite: false,
            // polygonOffset + a larger height gap stop the fog z-fighting the ground
            // when zoomed out (low depth precision at distance)
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
            side: THREE.DoubleSide
        });

        this.fogMesh = new THREE.Mesh(fogGeometry, fogMaterial);
        this.fogMesh.rotation.x = -Math.PI / 2;
        this.fogMesh.position.y = 0.6; // Clearly above ground to avoid z-fighting
        this.fogMesh.renderOrder = 2;
        this.scene.add(this.fogMesh);

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
        
        // Reveal fog around player units
        this.game.player.units.forEach(unit => {
            const range = unit.type === 'worker' ? this.unitVisionRange : 
                         (unit.unitType === 'cavalry' ? this.unitVisionRange * 1.2 : this.unitVisionRange);
            this.reveal(unit.x, unit.z, range);
        });
        
        // Reveal fog around player buildings
        this.game.player.buildings.forEach(building => {
            const range = building.type === 'tower' ? this.towerVisionRange : this.buildingVisionRange;
            this.reveal(building.x, building.z, range);
        });

        // In spectator mode, also reveal fog around ALL AI units and buildings
        // so the spectator sees everything any player can see
        if (this.game.spectatorMode && this.game.aiManager) {
            this.game.aiManager.aiPlayers.forEach(ai => {
                ai.units.forEach(unit => {
                    const range = unit.unitType === 'cavalry' ? this.unitVisionRange * 1.2 : this.unitVisionRange;
                    this.reveal(unit.x, unit.z, range);
                });
                ai.buildings.forEach(building => {
                    const range = building.type === 'tower' ? this.towerVisionRange : this.buildingVisionRange;
                    this.reveal(building.x, building.z, range);
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
        this.fogTexture.needsUpdate = true;
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
            this.reveal(townCenter.x, townCenter.z, this.buildingVisionRange * 1.5);
        }
        
        // Reveal around player's units
        this.game.player.units.forEach(unit => {
            this.reveal(unit.x, unit.z, this.unitVisionRange * 1.5);
        });
    }

    // Tear down the fog overlay so a new game doesn't layer a stale mesh over a
    // fresh one (which left old discovered areas "burned in" across arena games).
    destroy() {
        if (this.fogMesh) {
            this.scene.remove(this.fogMesh);
            if (this.fogMesh.geometry) this.fogMesh.geometry.dispose();
            if (this.fogMesh.material) this.fogMesh.material.dispose();
            this.fogMesh = null;
        }
        if (this.fogTexture) { this.fogTexture.dispose(); this.fogTexture = null; }
    }
}
