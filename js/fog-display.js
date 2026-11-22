// How the fog of war LOOKS: its colours, its soft edge, and the canvases the renderer
// uploads as the fog plane's texture. Presentation, not rules (build 1188): the fog's
// data and what it hides are js/fogofwar.js, a rule file; this file is outside the rules
// hash, so the fog can be redrawn without splitting comparable results.
//
// It adds three methods to FogOfWarManager, which that class calls when they are there:
//   initDisplay()   the canvases, when a manager is made
//   paintFog()      the grid drawn onto them, whenever the grid changed
//   dropDisplay()   the canvases let go, when a manager is destroyed
// Where this file is not loaded (a bare VM, a worker replaying a match) the fog is kept
// the same and never drawn.
(function () {
    if (typeof FogOfWarManager === 'undefined') return;

    // How far the reveal edge feathers, in WORLD units. Against a 15-unit unit
    // vision radius this is the difference between fog that is lit and fog that
    // is cut out with scissors.
    FogOfWarManager.FEATHER_WORLD = 5;

    // How far the fog reaches PAST the map, and the width it fades out over. The
    // plane used to be exactly mapSize, so it stopped dead at ±400 while the coast
    // runs out to ~416 — a hard square cut across the beach, fogged land on the
    // inside and fully lit shore on the outside. Fading BEYOND the map rather than
    // inside it means no part of the playable area trades fog integrity for the
    // effect: units clamp to ~396 and resources are seeded inside 360, so
    // everything past 400 is shoreline and open water.
    FogOfWarManager.EDGE_MARGIN_WORLD = 60;

    const P = FogOfWarManager.prototype;

    P.initDisplay = function () {
        // Grid canvas: exact 1 texel per fog cell (the data, drawn by paintFog)
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
    };

    P.paintFog = function () {
        const imageData = this.fogCtx.createImageData(this.numTiles, this.numTiles);
        const data = imageData.data;

        for (let i = 0; i < this.fogGrid.length; i++) {
            const idx = i * 4;
            const fogValue = this.fogGrid[i];

            // GRADED mode, used when a caller knows a FRACTION rather than a tier —
            // the transcript analyzer only learns how much of each map tile a seat
            // uncovered (map.exploration is a percentage), never which cells. Opacity
            // then scales with that fraction: 0% discovered is full fog, 86% leaves 14%
            // of it. Off by default, so the live game's three tiers are untouched.
            if (this.gradedFog && fogValue > 0 && fogValue < 2) {
                const f = Math.max(0, Math.min(1, fogValue));
                data[idx] = Math.round(46 + (64 - 46) * f);
                data[idx + 1] = Math.round(49 + (68 - 49) * f);
                data[idx + 2] = Math.round(56 + (76 - 56) * f);
                data[idx + 3] = Math.round(212 * (1 - f));
            } else if (fogValue === 0) {
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
    };

    P.dropDisplay = function () {
        this.fogDisplayCanvas = null;
        this.fogCanvas = null;
        this._scratchCanvas = null;
    };
})();
