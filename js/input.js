// Input handling for mouse interactions
class InputManager {
    constructor(renderer, game) {
        this.renderer = renderer;
        this.game = game;
        this.isDragging = false;
        this.isRightDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.dragEndX = 0;
        this.dragEndY = 0;
        this.hasDragged = false;
        this.hasRightDragged = false;
        this.dragThreshold = 5;
        this.mouseDownPos = { x: 0, y: 0 };

        this.init();
    }

    init() {
        const canvas = this.renderer.renderer.domElement;

        canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        // Release the spectator coordinate flag even if the mouse comes up off-canvas.
        window.addEventListener('mouseup', () => this.hideCoordFlag());

        // Touch support
        canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            this.onMouseDown({ clientX: touch.clientX, clientY: touch.clientY });
        });
        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            this.onMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
        });
        canvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.onMouseUp({ clientX: this.mouseDownPos.x, clientY: this.mouseDownPos.y });
        });
    }

    onMouseDown(event) {
        // Spectator/arena: no unit selection or commands — don't start a drag-select
        // (camera pan/rotate/zoom is handled separately by the renderer). Right-click,
        // though, drops a coordinate flag so the spectator can read off map positions
        // (handy for giving models coordinate-based advice). Held until release.
        if (this.game.spectatorMode) {
            if (event.button === 2) this.showCoordFlag(event.clientX, event.clientY);
            return;
        }
        // Skip middle-mouse-button - let Renderer handle camera rotation
        if (event.button === 1) return;

        const rect = this.renderer.renderer.domElement.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        if (event.button === 0) { // Left click - select
            this.isDragging = true;
            this.dragStartX = x;
            this.dragStartY = y;
            this.dragEndX = x;
            this.dragEndY = y;
            this.hasDragged = false;
            this.mouseDownPos = { x: event.clientX, y: event.clientY };
        } else if (event.button === 2) { // Right click - move/attack
            // Reset left-click state so it doesn't interfere with right-click
            this.isDragging = false;
            this.isRightDragging = true;
            this.mouseDownPos = { x: event.clientX, y: event.clientY };
            this.hasRightDragged = false;
        }
    }

    // Spectator helper: a small flag near the cursor showing the world (x, z) under
    // it, shown while right-click is held so the spectator can read map coordinates.
    showCoordFlag(clientX, clientY) {
        if (!this._coordFlag) {
            const el = document.createElement('div');
            el.className = 'coord-flag';
            el.style.display = 'none';
            document.body.appendChild(el);
            this._coordFlag = el;
        }
        const flag = this._coordFlag;
        const world = this.renderer.getWorldPositionFromScreen(clientX, clientY);
        flag.textContent = world ? `🚩 ${Math.round(world.x)}, ${Math.round(world.z)}` : '🚩 off map';
        flag.style.left = (clientX + 14) + 'px';
        flag.style.top = (clientY - 12) + 'px';
        flag.style.display = 'block';
    }

    hideCoordFlag() {
        if (this._coordFlag) this._coordFlag.style.display = 'none';
    }

    onMouseMove(event) {
        // While the spectator holds right-click, keep the coordinate flag under the cursor.
        if (this._coordFlag && this._coordFlag.style.display !== 'none') {
            this.showCoordFlag(event.clientX, event.clientY);
        }

        const rect = this.renderer.renderer.domElement.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // Update building placement preview if placing
        if (this.renderer.isPlacingBuilding) {
            const worldPos = this.renderer.getWorldPositionFromScreen(event.clientX, event.clientY);
            if (worldPos) {
                this.renderer.updateBuildingPreview(worldPos.x, worldPos.z);
            }
        }

        if (this.isDragging) {
            this.dragEndX = x;
            this.dragEndY = y;

            const dx = Math.abs(x - this.dragStartX);
            const dy = Math.abs(y - this.dragStartY);

            if (dx > this.dragThreshold || dy > this.dragThreshold) {
                this.hasDragged = true;
                this.renderer.showSelectionBox(
                    this.dragStartX, this.dragStartY,
                    this.dragEndX, this.dragEndY
                );
            }
        }

        if (this.isRightDragging) {
            const dx = Math.abs(event.clientX - this.mouseDownPos.x);
            const dy = Math.abs(event.clientY - this.mouseDownPos.y);
            if (dx > this.dragThreshold || dy > this.dragThreshold) {
                this.hasRightDragged = true;
            }
        }
    }

    onMouseUp(event) {
        // In spectator mode, disable all interactions (selection, movement, building)
        if (this.game.spectatorMode) {
            this.isDragging = false;
            this.isRightDragging = false;
            return;
        }

        if (this.isDragging && !this.hasDragged) {
            // Single click - select player unit or player building
            const worldPos = this.renderer.getWorldPositionFromScreen(event.clientX, event.clientY);
            if (worldPos) {
                // Select the player unit CLOSEST to the click (within its clickable
                // radius). Prioritised over buildings.
                const unit = this.renderer.pickUnitAt(worldPos.x, worldPos.z, 'player');
                if (unit) {
                    this.game.selectUnit(unit);
                } else {
                    // Only select player-owned buildings if no units selected
                    const buildings = this.renderer.getBuildingsAtPosition(worldPos.x, worldPos.z, 4, 'player');
                    if (buildings.length > 0) {
                        this.game.selectBuilding(buildings[0]);
                    } else {
                        // Clicked on empty ground - deselect all
                        this.renderer.deselectAll();
                        this.game.updateUnitInfo(null, null);
                    }
                }
            }
        } else if (this.isDragging && this.hasDragged) {
            // Box selection in SCREEN space: a unit is selected when its projected
            // position falls inside the rectangle the player actually drew — which
            // holds under any camera rotation/tilt. (The old test built a world
            // X/Z bounding box from the two projected corners, which only matched
            // the drawn rectangle at the default camera orientation.)
            const minSX = Math.min(this.dragStartX, this.dragEndX);
            const maxSX = Math.max(this.dragStartX, this.dragEndX);
            const minSY = Math.min(this.dragStartY, this.dragEndY);
            const maxSY = Math.max(this.dragStartY, this.dragEndY);

            const selected = this.renderer.units.filter(unit => {
                if (unit.owner !== 'player') return false;
                // Project at torso height so the test matches the visible body,
                // not the spot on the ground under it.
                const p = this.renderer.worldToScreen(unit.x, 1.0, unit.z);
                return p && p.x >= minSX && p.x <= maxSX && p.y >= minSY && p.y <= maxSY;
            });

            if (selected.length > 0) {
                this.renderer.selectMultipleUnits(selected);
                this.game.updateUnitInfo(selected[0], null);
            } else {
                // No player units in box - deselect
                this.renderer.deselectAll();
                this.game.updateUnitInfo(null, null);
            }
        }

        if (this.isRightDragging && !this.hasRightDragged) {
            // If placing building, confirm placement
            if (this.renderer.isPlacingBuilding) {
                const worldPos = this.renderer.getWorldPositionFromScreen(event.clientX, event.clientY);
                if (worldPos) {
                    // Fix 2: Allow building in explored areas (not just visible)
                    if (this.game.fogOfWar && !this.game.fogOfWar.isPositionVisible(worldPos.x, worldPos.z)) {
                        this.game.ui.showErrorMessage(t('msg.fogBuild'));
                        this.game.cancelBuildingPlacement();
                        return;
                    }
                    this.game.confirmBuildingPlacement(worldPos.x, worldPos.z);
                } else {
                    this.game.cancelBuildingPlacement();
                }
                return;
            }
            
            // Right click - move or attack
            const worldPos = this.renderer.getWorldPositionFromScreen(event.clientX, event.clientY);
            if (worldPos) {
                // Workers selected + right-click on one of YOUR buildings => send them
                // to finish its construction or repair it if it's damaged.
                const selWorkers = (this.renderer.selectedUnits || this.game.player.units.filter(u => u.selected))
                    .filter(u => u && u.owner === 'player' && u.type === 'worker');
                if (selWorkers.length) {
                    const ownBuilding = this.renderer.getBuildingsAtPosition(worldPos.x, worldPos.z, 5)
                        .filter(b => b.owner === 'player')
                        .find(b => b.underConstruction || b.health < b.maxHealth);
                    if (ownBuilding) {
                        const mode = this.game.assignWorkersToBuilding(selWorkers, ownBuilding);
                        if (mode === 'building') this.game.ui.showInfoMessage(t('msg.assignBuild'));
                        else if (mode === 'repairing') this.game.ui.showInfoMessage(t('msg.assignRepair'));
                        return;
                    }
                }

                // Check if position is in undiscovered area
                const isUndiscovered = this.game.fogOfWar && !this.game.fogOfWar.isPositionVisible(worldPos.x, worldPos.z);
                
                const units = this.renderer.getUnitsAtPosition(worldPos.x, worldPos.z, 2);
                
                // Check if clicking on enemy unit (attack) - only if visible
                const enemyUnits = units.filter(u => u.owner !== 'player' && u.owner !== undefined);
                
                // Check if clicking on enemy building (attack) - only if visible
                const enemyBuildings = this.renderer.getBuildingsAtPosition(worldPos.x, worldPos.z, 5)
                    .filter(b => b.owner !== 'player' && b.owner !== undefined);
                
                // Block attacking in undiscovered areas
                if (isUndiscovered && (enemyUnits.length > 0 || enemyBuildings.length > 0)) {
                    return; // Can't attack in undiscovered areas
                }
                
                if (enemyUnits.length > 0 && this.game.player.units.length > 0) {
                    // Attack enemy unit
                    this.game.attackTarget(enemyUnits[0]);
                } else if (enemyBuildings.length > 0 && this.game.player.units.length > 0) {
                    // Attack enemy building
                    this.game.attackTarget(enemyBuildings[0]);
                } else {
                    // Move units - allow movement into undiscovered areas
                    this.game.moveUnits(worldPos.x, worldPos.z);
                    
                    // Move camera if clicking on edge of screen
                    const rect = this.renderer.renderer.domElement.getBoundingClientRect();
                    if (event.clientX - rect.left < 50) {
                        this.renderer.moveCameraTo(worldPos.x - 10, worldPos.z);
                    } else if (event.clientX - rect.left > rect.width - 50) {
                        this.renderer.moveCameraTo(worldPos.x + 10, worldPos.z);
                    }
                    if (event.clientY - rect.top < 50) {
                        this.renderer.moveCameraTo(worldPos.x, worldPos.z - 10);
                    } else if (event.clientY - rect.top > rect.height - 50) {
                        this.renderer.moveCameraTo(worldPos.x, worldPos.z + 10);
                    }
                }
            }
        }

        this.isDragging = false;
        this.isRightDragging = false;
        this.renderer.hideSelectionBox();
    }
}
