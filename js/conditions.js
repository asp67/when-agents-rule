// ---------------------------------------------------------------------------
// Match conditions, and the ONE rule for when two results are comparable.
//
// A result belongs to (model x stack x settings), and until now nothing on file could
// show that two results shared the rest: prompt, tools, rules, protocol. Hand-bumped
// versions (build, promptVersion) cover only what someone remembered to bump. So the
// conditions are fingerprinted from what was actually offered and what actually ran:
//
//   coreHash    the simulation sources, LF-normalized, in CORE_FILES order
//   familyHash  one seat's contract without its seat-specific parts (civilization,
//               language): prompt template, tool schemas, limits, history mode, tool
//               fallback, and the harness source that writes every error a model reads
//   rulesId     the ruleset; 'classic@0' until a second ruleset exists
//   protocol    'real-time' or 'turn-based'
//
// Same four => "same declared conditions". Not "an identical match": seeds, opponents
// and sampling still differ, and results must be read as distributions.
// Every consumer (results, analyzer, exports, a future compare page or bench) asks
// comparable() here rather than growing its own rule.
// ---------------------------------------------------------------------------
const WarConditions = {
    SCHEMA: 'war-contract/1',
    RULES_ID: 'classic@0',
    // Files whose code decides what happens in the world, from the one list of them
    // (js/manifest.js). The renderer is not among them: it decides nothing, so a change
    // to how the game LOOKS does not split comparable results.
    get CORE_FILES() { return WarManifest.rules; },
    get HARNESS_FILE() { return WarManifest.harness; },

    lf(text) { return String(text == null ? '' : text).replace(/\r\n/g, '\n'); },
    // JSON with sorted keys, so the same value always hashes the same.
    canon(v) {
        if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
        if (Array.isArray(v)) return '[' + v.map(x => WarConditions.canon(x)).join(',') + ']';
        return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
            .map(k => JSON.stringify(k) + ':' + WarConditions.canon(v[k])).join(',') + '}';
    },
    hash(v) { return warSha256(typeof v === 'string' ? v : WarConditions.canon(v)); },
    // Lockstep rounds with different slices are different games: the slice is part of it.
    protocolOf(header) {
        if (!header || !header.turnBased) return 'real-time';
        return header.lockstepSliceMs ? 'turn-based-lockstep-' + header.lockstepSliceMs + 'ms' : 'turn-based';
    },

    // Source text of a file as this page loaded it: the same ?v= the script tag used, so
    // a cached older copy cannot be hashed in its place. null when it cannot be read
    // (file://), which the record then says rather than inventing a value.
    async source(file) {
        try {
            const tag = typeof document !== 'undefined'
                ? [...document.querySelectorAll('script[src]')].find(s => (s.getAttribute('src') || '').split('?')[0] === file) : null;
            const res = await fetch(tag ? tag.getAttribute('src') : file, { cache: 'no-store' });
            return res.ok ? WarConditions.lf(await res.text()) : null;
        } catch (e) { return null; }
    },
    async sourceHashes() {
        const core = await Promise.all(WarConditions.CORE_FILES.map(f => WarConditions.source(f)));
        const harness = await WarConditions.source(WarConditions.HARNESS_FILE);
        return {
            coreHash: core.every(t => t != null) ? warSha256(core.join('\n')) : null,
            harnessHash: harness != null ? warSha256(harness) : null,
        };
    },

    // One seat's conditions, from the header and the contract record. null parts stay
    // null, and a seat with any null part is comparable with nothing.
    seat(header, contract, playerId) {
        const s = contract && (contract.seats || []).find(x => x.playerId === playerId);
        if (!s) return null;
        return { coreHash: contract.coreHash || null, familyHash: s.familyHash || null,
                 rulesId: contract.rulesId || null, protocol: WarConditions.protocolOf(header) };
    },
    complete(c) { return !!(c && c.coreHash && c.familyHash && c.rulesId && c.protocol); },
    // A short, stable name for a set of conditions: 12 hex characters.
    id(c) { return WarConditions.complete(c) ? WarConditions.hash(c).slice(0, 12) : null; },
    comparable(a, b) {
        return WarConditions.complete(a) && WarConditions.complete(b)
            && a.coreHash === b.coreHash && a.familyHash === b.familyHash
            && a.rulesId === b.rulesId && a.protocol === b.protocol;
    },
};
