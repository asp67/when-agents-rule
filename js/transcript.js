// ---------------------------------------------------------------------------
// Match transcripts — the verbatim exchange with each model, for analysis.
//
// The decision log shows what a model DID. This records what it was SHOWN and
// what it SAID, unedited: the full state JSON it received, its reply, its
// reasoning where the provider exposes it, and the harness's answer. Enough to
// follow the back and forth turn by turn after the fact.
//
// Why not reuse controller.turnLog: that exists to replay cheap history back to
// the model, and is lossy by design — the reply is collapsed and cut to 600
// characters, it keeps content OR reasoning but never both, and its "user" is
// the COMPACT state rather than the full one the model actually saw.
//
// Storage is OPFS (origin-private files), measured at ~0.3ms per turn against
// an ~11GB quota, so recording every player of every match is free in practice.
// One append-only JSONL file per player: each line parses on its own, so a file
// truncated by a crash still yields every complete turn before it — which a
// single big JSON array would not.
//
// Lifetime is deliberately one match. The results screen offers the download and
// says the transcripts go when it closes; nothing accumulates on disk behind the
// user's back. purge() also runs at match START, because "Hauptmenü" reloads the
// page and an async delete cannot be relied on during unload.
// ---------------------------------------------------------------------------
class TranscriptRecorder {
    constructor() {
        this.matchId = null;
        this.dirName = null;
        this.mem = new Map();      // playerId -> [entry] (ring, for the UI)
        this.pending = new Map();  // playerId -> [line] awaiting a disk flush
        this.meta = new Map();     // playerId -> {civ, model, seat}
        this.counts = new Map();   // playerId -> turns recorded (survives the ring)
        this.open = new Map();     // playerId -> turn awaiting its harness result
        this.MEM_CAP = 300;        // turns kept in memory per player
        this.FLUSH_EVERY = 10;     // turns buffered before an append
        this.available = !!(navigator.storage && navigator.storage.getDirectory);
        this._writing = Promise.resolve(); // serialises appends; concurrent
                                           // seek+write on one file would interleave
    }

    static ROOT() { return 'transcripts'; }

    async _root(create = false) {
        if (!this.available) return null;
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(TranscriptRecorder.ROOT(), { create });
    }

    // Start a fresh match. Wipes anything left over first: a crash or a reload
    // during the previous match can leave files that were never offered for
    // download, and the promise to the user is a clean slate every time.
    // `match` describes the CONDITIONS: map seed, difficulty, and the settings that
    // change what a result means (sim speed, turn-based, any resource boost). Written
    // as the file's first line, tagged type:"match" so a reader can tell it from a
    // turn. Without it a folder of transcripts is a folder of numbers with no way to
    // tell which ran doubled, at 2x, or turn-based — cheap to record now and
    // unrecoverable later.
    async begin(matchId, players, match) {
        await this.purge();
        this.matchId = matchId;
        this.mem.clear(); this.pending.clear(); this.meta.clear(); this.counts.clear(); this.open.clear();
        (players || []).forEach(p => this.meta.set(p.id, {
            civ: p.civilization, seat: p.seat, model: p.model || null, name: p.name || null
        }));
        this.matchMeta = Object.assign({ type: 'match', matchId, startedAt: Date.now() },
            match || {},
            { players: (players || []).map(p => ({
                id: p.id, seat: p.seat, civ: p.civilization,
                model: p.model || null, name: p.name || null })) });
        try {
            const buf = this.pending.get('__match__') || [];
            buf.push(JSON.stringify(this.matchMeta) + '\n');
            this.pending.set('__match__', buf);
            await this.flush('__match__');
        } catch (e) { console.warn('[transcript] match header failed', e); }
    }

    // One turn. Never throws into the caller: a recording failure must not cost
    // a model its move.
    //
    // A turn is not queued for disk the moment it is recorded, because its other
    // half — the harness's answer — only exists once the action has executed. It
    // is held OPEN until noteResult stamps that on, or until the next turn
    // displaces it. Queuing immediately meant a flush landing in that window
    // wrote the line without the result, and no later amend could reach it.
    record(playerId, entry) {
        if (!this.matchId || !playerId) return;
        try {
            this._seal(playerId);                       // the previous turn is done
            const n = (this.counts.get(playerId) || 0) + 1;
            this.counts.set(playerId, n);
            const full = Object.assign({ turn: n, playerId }, this.meta.get(playerId) || {},
                { harnessResult: null }, entry);

            const ring = this.mem.get(playerId) || [];
            ring.push(full);
            if (ring.length > this.MEM_CAP) ring.splice(0, ring.length - this.MEM_CAP);
            this.mem.set(playerId, ring);
            this.open.set(playerId, full);
        } catch (e) {
            console.warn('[transcript] record failed', e);
        }
    }

    // Move an open turn into the disk queue.
    _seal(playerId) {
        const t = this.open.get(playerId);
        if (!t) return;
        this.open.delete(playerId);
        const buf = this.pending.get(playerId) || [];
        buf.push(JSON.stringify(t) + '\n');
        this.pending.set(playerId, buf);
        if (buf.length >= this.FLUSH_EVERY) this.flush(playerId);
    }

    // Append this player's buffered turns. Chained onto _writing so two flushes
    // can't both read the same file size and write over each other.
    flush(playerId) {
        const buf = this.pending.get(playerId);
        if (!this.available || !this.matchId || !buf || !buf.length) return this._writing;
        const lines = buf.join('');
        this.pending.set(playerId, []);
        this._writing = this._writing.then(async () => {
            try {
                const dir = await (await this._root(true)).getDirectoryHandle(this.matchId, { create: true });
                const fh = await dir.getFileHandle(`${playerId}.jsonl`, { create: true });
                const size = (await fh.getFile()).size;
                const w = await fh.createWritable({ keepExistingData: true });
                await w.seek(size);          // append, not overwrite
                await w.write(lines);
                await w.close();
            } catch (e) {
                console.warn('[transcript] flush failed', e);
            }
        });
        return this._writing;
    }

    async flushAll() {
        // Seal stragglers first, or the final turn of a match never reaches disk.
        for (const id of [...this.open.keys()]) this._seal(id);
        for (const id of this.pending.keys()) this.flush(id);
        return this._writing;
    }

    // The harness's answer to the last recorded turn. It arrives after the reply,
    // because the action has to execute first — so it is stamped onto the open turn,
    // which is then sealed. The ring holds the same object, so the in-memory copy
    // gains the result too.
    noteResult(playerId, harnessResult) {
        if (!this.matchId || !playerId) return;
        const t = this.open.get(playerId);
        if (!t) return;                    // already sealed by the next turn
        t.harnessResult = harnessResult;
        this._seal(playerId);
    }

    // Last N turns for a player, newest last — for an on-screen viewer.
    recent(playerId) { return (this.mem.get(playerId) || []).slice(); }

    // How many turns this player has recorded. Cheap enough to ask once per log
    // entry per repaint, which recent() — it copies the whole ring — is not.
    turnsFor(playerId) { return this.counts.get(playerId) || 0; }

    turnsRecorded() {
        let n = 0; this.counts.forEach(v => { n += v; }); return n;
    }
    hasData() { return this.turnsRecorded() > 0; }

    // Everything, as one JSONL blob. Merged rather than zipped: every line
    // already carries playerId/civ/turn, so one file stays greppable and needs
    // no archive support to read.
    async exportBlob() {
        await this.flushAll();
        const parts = [];
        let header = null;
        try {
            const dir = await (await this._root(true)).getDirectoryHandle(this.matchId, { create: true });
            for await (const [name, h] of dir.entries()) {
                if (!name.endsWith('.jsonl') || h.kind !== 'file') continue;
                const text = await (await h.getFile()).text();
                // The match header goes FIRST, so anyone opening the file learns the
                // conditions before the turns rather than hunting for them.
                if (name === '__match__.jsonl') header = text; else parts.push(text);
            }
        } catch (e) {
            console.warn('[transcript] export failed', e);
        }
        // Fall back to memory if the disk read yielded nothing, so a download
        // never comes back empty just because storage misbehaved.
        if (!parts.length) {
            this.mem.forEach(ring => ring.forEach(e => parts.push(JSON.stringify(e) + '\n')));
        }
        if (!header && this.matchMeta) header = JSON.stringify(this.matchMeta) + '\n';
        return new Blob(header ? [header, ...parts] : parts, { type: 'application/x-ndjson' });
    }

    // Delete every transcript on disk and in memory.
    async purge() {
        this.mem.clear(); this.pending.clear(); this.counts.clear(); this.open.clear();
        if (!this.available) return;
        try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(TranscriptRecorder.ROOT(), { recursive: true });
        } catch (e) { /* nothing recorded yet — fine */ }
    }
}
