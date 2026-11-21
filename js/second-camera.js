// The second camera (overhaul step B3): a fight the main picture is not showing plays in
// a small picture beside the minimap, live, instead of going unseen.
//
// It is the same world at the same moment, drawn a second time by the one renderer from
// another place (EngineRenderer.secondView, js/engine/gamerenderer.js), in 3-D like the
// main picture. It decides nothing about the match and nothing about the main camera:
// the director's list of live fights is read, never written.
//
// High quality only: a second picture is a second pass over the scene every frame. Off
// until asked for (the bar's button, the icon on the broadcast board, or I).
(function () {
    // ---- which fight, and for how long -------------------------------------------
    // A small picture that opens and closes with every blow is worse than none. So a
    // fight has to go unseen for a moment before the picture opens, the picture stays
    // on that fight while it is fought, and lingers on the ground a little after.
    class SecondCamera {
        constructor() { this.reset(); }
        reset() { this.cur = null; this.unseen = new Map(); this.pose = null; }

        // fights: every fight being fought now, best first:
        //   { key, x, z, half, seats: [seat ids], onMain: the main picture shows it }
        // Returns the fight the second picture is on, or null.
        update(now, fights) {
            const C = SecondCamera, off = fights.filter(f => !f.onMain);
            for (const k of [...this.unseen.keys()]) if (!off.some(f => f.key === k)) this.unseen.delete(k);
            for (const f of off) if (!this.unseen.has(f.key)) this.unseen.set(f.key, now);
            if (this.cur) {
                const f = off.find(f => f.key === this.cur.key);
                if (f) { Object.assign(this.cur, { x: f.x, z: f.z, half: f.half, seats: f.seats, liveAt: now }); return this.cur; }
                // Over, or the main picture has gone to it: the second one has no reason to
                // repeat what the main one shows, and stays a moment on a fight that ended.
                const taken = fights.some(f => f.key === this.cur.key);
                if (now - this.cur.liveAt < (taken ? C.TAKEN_MS : C.LINGER_MS)) return this.cur;
                this.cur = null; this.pose = null;
            }
            const next = off.find(f => now - this.unseen.get(f.key) >= C.APPEAR_MS);
            if (!next) return null;
            this.cur = { key: next.key, x: next.x, z: next.z, half: next.half, seats: next.seats, since: now, liveAt: now };
            return this.cur;
        }

        // Where the camera stands now. It opens on the fight and then glides after it:
        // fighters join and break off all the time, and a picture that followed the
        // centre of the fight exactly would never hold still.
        view(now) {
            const c = this.cur;
            if (!c) return null;
            const p = this.pose;
            if (!p) return (this.pose = { x: c.x, z: c.z, halfH: c.half, at: now });
            const k = 1 - Math.exp(-Math.max(0, Math.min(250, now - p.at)) / 1000 * SecondCamera.EASE);
            p.x += (c.x - p.x) * k; p.z += (c.z - p.z) * k; p.halfH += (c.half - p.halfH) * k; p.at = now;
            return p;
        }

        // The frame around a fight of this radius: tighter than the main camera's, the
        // picture being a fifth of its size.
        static halfFor(r) { return Math.max(11, Math.min(40, (r || 0) * 1.3 + 7)); }
    }
    SecondCamera.APPEAR_MS = 1200;   // a fight is unseen this long before the picture opens
    SecondCamera.LINGER_MS = 1500;   // the picture stays this long after the last of the fight
    SecondCamera.TAKEN_MS = 600;     // ...and this long once the main picture shows the same fight
    SecondCamera.EASE = 3;           // how fast the camera closes on where the fight is, per second
    SecondCamera.YAW = Math.PI / 4;  // the play camera's bearing, so the small picture has the map's north
    SecondCamera.PITCH = 0.44;       // the director's own pitch for a fight
    SecondCamera.MAIN_HALF = 130;    // a main picture wider than this shows dots, not the fight
    SecondCamera.TIER = 'cinematic'; // High
    if (typeof window !== 'undefined') window.SecondCamera = SecondCamera;
    if (typeof module !== 'undefined' && module.exports) module.exports = SecondCamera;

    if (typeof UIManager === 'undefined') return;
    const P = UIManager.prototype;

    P.secondOn = function () { return !!this.viewPreferences().second; };
    P.toggleSecondCam = function (on = !this.secondOn()) {
        this.viewPreferences().second = !!on;
        this.saveViewPreferences();
        this.refreshSecondCam();
        if (this.broadcastOn && this.broadcastOn() && this.renderBroadcast) this.renderBroadcast();   // its icon on the board follows
    };
    P.refreshSecondCam = function () {
        const on = this.secondOn(), btn = document.getElementById('secondCamBtn');
        if (btn) { btn.classList.toggle('sb-on', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        this.updateSecondCam();
    };

    // The fights being fought now, best first, as the director keeps them; each with the
    // seats in it and whether the main picture shows it. The fight the second picture is
    // on has to come well inside the main one to count as shown there, and any other has
    // to be well outside it to count as unseen: at the frame's edge neither flips.
    P.secondFights = function (now, shownKey) {
        const g = this.game, d = g._director, r = g.renderer;
        if (!d || !r) return [];
        // With the action camera off nobody else keeps the director's fights current.
        if (!g._actionCam) d.scanThreats(now);
        const ais = (g.aiManager && g.aiManager.aiPlayers) || [];
        const w = r.canvas.clientWidth, h = r.canvas.clientHeight;
        return d.fights(now).filter(f => f.active).sort((a, b) => b.score - a.score).map(f => {
            const seats = [];
            for (const p of f.encounter.participants) if (p.health > 0 && !seats.includes(p.owner) && ais.some(a => a.id === p.owner)) seats.push(p.owner);
            const s = r.worldToScreen(f.x, 1, f.z), m = f.key === shownKey ? 0.08 : -0.05;
            const inFrame = !!s && s.x >= w * m && s.x <= w * (1 - m) && s.y >= h * m && s.y <= h * (1 - m);
            return { key: f.key, x: f.x, z: f.z, half: SecondCamera.halfFor(f.r), seats, onMain: inFrame && r._halfH <= SecondCamera.MAIN_HALF };
        });
    };

    // Four times a second: which fight, if any, and the frame around the picture.
    P.updateSecondCam = function (now = Date.now()) {
        const el = document.getElementById('secondCam'), canvas = document.getElementById('secondCamCanvas');
        if (!el || !canvas) return null;
        const g = this.game, r = g.renderer, cam = this._second || (this._second = new SecondCamera());
        // Not over a recording being read in the analyzer: its fights are not the director's.
        const can = this.secondOn() && g.spectatorMode && g.gameStarted && r && r.graphicsQuality === SecondCamera.TIER && !r.replayMode && !r.poseSource;
        const cur = can ? cam.update(now, this.secondFights(now, cam.cur && cam.cur.key)) : null;
        if (!cur) {
            if (!can) cam.reset();
            if (el.style.display !== 'none') el.style.display = 'none';
            this._secondSig = null;
            return null;
        }
        if (el.style.display === 'none') el.style.display = '';
        // The picture is drawn at the size it is shown, times what the main one is drawn at.
        const box = canvas.getBoundingClientRect(), scale = Math.min(1.5, r.renderScale || 1);
        const cw = Math.max(1, Math.round(box.width * scale)), ch = Math.max(1, Math.round(box.height * scale));
        if (canvas.width !== cw) canvas.width = cw;
        if (canvas.height !== ch) canvas.height = ch;
        const sig = cur.key + '|' + cur.seats.join(',');
        if (sig !== this._secondSig) {
            this._secondSig = sig;
            const head = document.getElementById('secondCamHead');
            if (head) head.innerHTML = '<b>' + this.escapeHtml(t('second.title')) + '</b>'
                + (cur.seats.length ? '<span>' + cur.seats.map(id => this.chronicleSeatHtml(id)).join(' <i>·</i> ') + '</span>' : '');
        }
        return cur;
    };

    // What the renderer asks every frame: where the second picture stands and the canvas
    // it goes into, or nothing.
    P.secondViewPose = function (now) {
        const cam = this._second, canvas = document.getElementById('secondCamCanvas');
        if (!cam || !cam.cur || !canvas || !(canvas.width > 1)) return null;
        const el = document.getElementById('secondCam');
        if (!el || el.style.display === 'none') return null;
        const p = cam.view(now);
        return p && { x: p.x, z: p.z, halfH: p.halfH, yaw: SecondCamera.YAW, pitch: SecondCamera.PITCH, canvas };
    };
})();
