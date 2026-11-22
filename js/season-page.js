// ---------------------------------------------------------------------------
// The Season page (overhaul step D9): evaluation profiles per model across matches.
//
// Three sources of matches, one table (js/eval/season.js):
//   - the sample matches that ship with WAR (samples/season.json, written by
//     tools/eval/season.cjs), which can be left out;
//   - every arena match that ended in this browser: a small entry is kept when the
//     results screen opens (the scores and who sat where; no prompts, no replies);
//   - transcript files added here, scored on the spot by the same ledger.
// What is kept lives in this browser (localStorage) and can be forgotten match by match.
//
// The table adds results up only under the same declared conditions and the same scoring
// scale; every other set of conditions is a group of its own, and seats whose conditions
// were not recorded are listed and compared with nothing. Nothing is marked as ahead on
// one match, or while two intervals touch.
// ---------------------------------------------------------------------------
class SeasonPage {
    constructor(ui) {
        this.ui = ui;
        this.samples = null;        // the shipped entries, once fetched
        this.showSamples = true;
        this.note = '';
    }

    static get STORE() { return 'war.season.v1'; }
    static load() {
        try {
            const v = JSON.parse(localStorage.getItem(SeasonPage.STORE) || 'null');
            return v && Array.isArray(v.entries) ? v.entries : [];
        } catch (e) { return []; }
    }
    static save(entries) {
        try { localStorage.setItem(SeasonPage.STORE, JSON.stringify({ kind: 'war-season-entries/1', entries })); return true; }
        catch (e) { return false; }       // a private window, or storage that is full: the page says so
    }
    // Keep a match. One entry per match id: a second look at the same match replaces the first.
    static keep(entry) {
        if (!entry || !Array.isArray(entry.seats) || !entry.seats.length) return false;
        const same = e => entry.matchId ? e.matchId === entry.matchId : (entry.file && e.file === entry.file && !e.matchId);
        const list = SeasonPage.load().filter(e => !same(e));
        list.push(entry);
        return SeasonPage.save(list);
    }
    static forget(matchId) { return SeasonPage.save(matchId == null ? [] : SeasonPage.load().filter(e => (e.matchId || e.file) !== matchId)); }

    esc(s) { return this.ui.escapeHtml(s == null ? '' : String(s)); }
    el(id) { return document.getElementById(id); }

    async open() {
        const from = document.querySelector('.screen.active');
        if (from && from.id !== 'seasonScreen') this.returnTo = from.id;
        this.ui.showScreen('seasonScreen');
        this.note = '';
        this.render();
        await this.loadSamples();
        this.render();
    }
    close() { this.ui.showScreen(this.returnTo || 'startScreen'); }
    async loadSamples() {
        if (this.samples) return;
        try {
            const res = await fetch('samples/season.json');
            const v = res.ok ? await res.json() : null;
            this.samples = v && Array.isArray(v.entries) ? v.entries : [];
        } catch (e) { this.samples = []; }
    }
    // What the table is made of: this browser's matches first, so a sample that was also
    // played or added here is counted as the copy kept here.
    entries() { return SeasonPage.load().concat(this.showSamples ? (this.samples || []) : []); }

    setSamples(on) { this.showSamples = !!on; this.render(); }
    forget(matchId) { SeasonPage.forget(matchId); this.note = ''; this.render(); }
    // Transcript files, scored here. A file that is not a match transcript is named, not skipped in silence.
    async addFiles(files) {
        const added = [], refused = [];
        let full = false;
        for (const f of Array.from(files || [])) {
            let entry = null;
            try { entry = WarSeason.entryOf(await f.text(), { evaluator: WarEval, conditions: WarConditions, source: 'imported', file: f.name }); }
            catch (e) { entry = null; }
            if (!entry) { refused.push(f.name); continue; }
            if (SeasonPage.keep(entry)) added.push(f.name); else full = true;
        }
        this.note = [added.length ? t('season.added', { n: added.length }) : '', refused.length ? t('season.refused', { files: refused.join(', ') }) : '',
            full ? t('season.storeFailed') : ''].filter(Boolean).join(' ');
        this.render();
    }
    onLanguageChanged() {
        if (this.el('seasonScreen') && this.el('seasonScreen').classList.contains('active')) this.render();
    }

    // ---- Drawing ------------------------------------------------------------------
    // A mean with its interval: the number, the range under it, and both on a 0-100 track
    // so two rows can be compared by eye. One match is a number and the words "1 match".
    // `sp` is the spread over the same matches (build 1225): the lowest, the median and the
    // highest under the interval, and a tick on the track for every single match.
    cell(x, lead, sp) {
        if (!x || x.mean == null) return '<td class="sn-cell is-empty"><b>–</b></td>';
        const ticks = sp && sp.n >= 2 ? sp.values.map(v => `<em style="left:${v}%"></em>`).join('') : '';
        const range = x.n < 2 ? `<small>${this.esc(t('season.oneMatch'))}</small><i class="sn-range"><s style="left:${x.mean}%"></s></i>`
            : `<small>${x.lo.toFixed(0)}–${x.hi.toFixed(0)}</small>`
                + (sp && sp.n >= 2 ? `<small class="sn-spread">${sp.min.toFixed(0)} · ${sp.median.toFixed(0)} · ${sp.max.toFixed(0)}</small>` : '')
                + `<i class="sn-range"><u style="left:${x.lo}%;width:${Math.max(1, x.hi - x.lo)}%"></u>${ticks}<s style="left:${x.mean}%"></s></i>`;
        const tip = x.n < 2 ? t('season.oneMatchTip') : t('season.cellTip', { mean: x.mean.toFixed(1), lo: x.lo.toFixed(1), hi: x.hi.toFixed(1), n: x.n })
            + (sp && sp.n >= 2 ? ' ' + t('season.spreadTip', { min: sp.min.toFixed(1), median: sp.median.toFixed(1), max: sp.max.toFixed(1), values: sp.values.map(v => v.toFixed(0)).join(', ') }) : '');
        return `<td class="sn-cell${lead ? ' is-lead' : ''}" title="${this.esc(tip + (lead ? ' ' + t('season.leadTip') : ''))}"><b>${x.mean.toFixed(0)}${lead ? ' ★' : ''}</b>${range}</td>`;
    }
    // Who played: the model's own answers, or an agent framework with the model inside it.
    viaTag(via) {
        if (!via) return '';
        const harness = String(via).startsWith('harness'), name = harness ? String(via).split(':')[1] : '';
        return ` <em class="bf-kind ${harness ? 'is-harness' : 'is-raw'}" title="${this.esc(t(harness ? 'bench.h.harnessTip' : 'bench.h.rawTip'))}">${this.esc(t(harness ? 'bench.h.harness' : 'bench.h.raw'))}${name ? ' · ' + this.esc(name) : ''}</em>`;
    }
    head() {
        return `<tr><th>${this.esc(t('season.model'))}</th><th>${this.esc(t('season.matches'))}</th><th>${this.esc(t('season.firsts'))}</th><th title="${this.esc(t('season.placesTip'))}">${this.esc(t('season.places'))}</th>`
            + WarSeason.PARTS.map(p => `<th>${this.esc(t('eval.' + p))}</th>`).join('') + '</tr>';
    }
    group(g) {
        const L = k => this.esc(WarSeason.label(k)), signed = v => (v > 0 ? '+' : '') + v.toFixed(1);
        // Every placement, oldest first; a long history shows its newest twelve.
        const places = m => { const a = m.places || []; return a.length ? (a.length > 12 ? '… ' : '') + a.slice(-12).map(x => x.rank).join(' · ') : '–'; };
        const rows = g.models.map(m => `<tr><th scope="row" title="${this.esc(m.model || '')}">${this.esc(m.name || m.model || '?')}${this.viaTag(m.via)}</th><td>${m.matches}</td><td>${m.firsts}</td>`
            + `<td class="sn-places" title="${this.esc(t('season.placesTip'))}">${places(m)}</td>`
            + WarSeason.PARTS.map(p => this.cell(m.parts[p], g.leaders[p] === m.key, m.spread && m.spread[p])).join('') + '</tr>').join('');
        // Raw models and agent harnesses in one table: said under it.
        const kinds = new Set(g.models.map(m => m.via ? String(m.via).split(':')[0] : null).filter(Boolean));
        const mixed = kinds.size > 1 ? `<p class="season-verdict">${this.esc(t('season.mixed'))}</p>` : '';
        const led = WarSeason.PARTS.some(p => g.leaders[p]);
        const verdict = g.models.length < 2 ? t('season.oneModel') : led ? t('season.someLead')
            : g.models.some(m => m.matches < 2) ? t('season.needTwo') : t('season.touch');
        const h2h = g.headToHead.map(h => `<li>${this.esc(t('season.met', { a: WarSeason.label(h.a), b: WarSeason.label(h.b), n: h.met, aAhead: h.aAhead, bAhead: h.bAhead }))}</li>`).join('');
        const swaps = g.swaps.map(s => {
            const d = s.diff.index;
            const what = d.mean == null ? '–' : d.n < 2 ? t('season.swapOne', { d: signed(d.mean) })
                : t(WarSeason.apartFromZero(d) ? 'season.swapApart' : 'season.swapTouch', { d: signed(d.mean), lo: signed(d.lo), hi: signed(d.hi) });
            return `<li>${L(s.a)} − ${L(s.b)}: ${this.esc(t('season.swap', { n: s.pairs }))} ${this.esc(what)}</li>`;
        }).join('');
        return `<section class="season-group">
            <h3>${this.esc(t('season.conditions'))} <code>${this.esc(g.id)}</code><small>${this.esc(t('season.groupMeta', { protocol: g.protocol || '?', builds: g.builds.join(', ') || '–', scale: g.scale || '?', n: g.matches }))}</small></h3>
            <div class="season-scroll"><table class="season-table"><thead>${this.head()}</thead><tbody>${rows}</tbody></table></div>
            <p class="season-verdict">${this.esc(verdict)}</p>${mixed}
            ${h2h ? `<h4>${this.esc(t('season.headToHead'))}</h4><ul class="season-list">${h2h}</ul>` : ''}
            ${swaps ? `<h4>${this.esc(t('season.swaps'))}</h4><ul class="season-list">${swaps}</ul>` : ''}
        </section>`;
    }
    // Seats that stand alone, or whose conditions are unknown: listed, never added up.
    loose(key, rows, withCond) {
        if (!rows.length) return '';
        const body = rows.map(u => `<tr><th scope="row">${this.esc(u.name || u.model || '?')}</th>${withCond ? `<td><code>${this.esc(u.cond)}</code></td>` : ''}<td>${u.build == null ? '–' : this.esc(u.build)}</td>`
            + `<td>${u.rank == null ? '–' : this.esc(t('season.placed', { rank: u.rank, of: u.of }))}</td>`
            + WarSeason.PARTS.map(p => `<td>${u.scores[p] == null ? '–' : Math.round(u.scores[p])}</td>`).join('') + '</tr>').join('');
        return `<details class="season-loose"><summary>${this.esc(t(key, { n: rows.length }))}</summary>
            <p class="season-verdict">${this.esc(t(key + 'Note'))}</p>
            <div class="season-scroll"><table class="season-table is-plain"><thead><tr><th>${this.esc(t('season.model'))}</th>${withCond ? `<th>${this.esc(t('season.conditions'))}</th>` : ''}<th>${this.esc(t('season.build'))}</th><th>${this.esc(t('season.place'))}</th>`
            + WarSeason.PARTS.map(p => `<th>${this.esc(t('eval.' + p))}</th>`).join('') + `</tr></thead><tbody>${body}</tbody></table></div></details>`;
    }
    kept() {
        const list = SeasonPage.load();
        if (!list.length) return '';
        const when = at => { if (!at) return '–'; const d = new Date(at), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
        const rows = list.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).map(e => {
            const key = e.matchId || e.file;
            return `<tr><td>${this.esc(when(e.at))}</td><td>${this.esc(t(e.source === 'imported' ? 'season.srcImported' : 'season.srcPlayed'))}</td>`
                + `<td>${this.esc(e.seats.map(s => s.name || s.model || '?').join(' · '))}</td><td>${this.esc(e.duration || '–')}</td>`
                + `<td><button class="test-btn" onclick="game.ui.seasonPage().forget('${this.esc(String(key).replace(/['\\]/g, ''))}')">${this.esc(t('season.forget'))}</button></td></tr>`;
        }).join('');
        return `<details class="season-loose"><summary>${this.esc(t('season.kept', { n: list.length }))}</summary>
            <p class="season-verdict">${this.esc(t('season.keptNote'))}</p>
            <div class="season-scroll"><table class="season-table is-plain"><tbody>${rows}</tbody></table></div>
            <button class="test-btn" onclick="game.ui.seasonPage().forget(null)">${this.esc(t('season.forgetAll'))}</button></details>`;
    }
    html() {
        const table = WarSeason.table(this.entries()), kept = SeasonPage.load().length, samples = (this.samples || []).length;
        const bar = `<div class="season-bar">
            <button class="menu-btn back-btn" onclick="game.ui.seasonPage().close()">${this.esc(t('common.back'))}</button>
            <label class="menu-btn back-btn season-file">${this.esc(t('season.add'))}<input type="file" accept=".jsonl,.txt,.json" multiple hidden onchange="game.ui.seasonPage().addFiles(this.files); this.value = '';"></label>
            <label class="season-check"><input type="checkbox" ${this.showSamples ? 'checked' : ''} onchange="game.ui.seasonPage().setSamples(this.checked)"> ${this.esc(t('season.samples', { n: samples }))}</label>
            <span class="season-count">${this.esc(t('season.count', { n: table.matches, kept }))}</span>
        </div>`;
        const note = this.note ? `<p class="season-note">${this.esc(this.note)}</p>` : '';
        const how = `<p class="season-how">${this.esc(t('season.how'))}</p>`;
        if (!table.matches) return bar + note + how + `<p class="season-empty">${this.esc(t(this.samples ? 'season.empty' : 'season.loading'))}</p>`;
        return bar + note + how
            + (table.groups.length ? table.groups.map(g => this.group(g)).join('') : `<p class="season-empty">${this.esc(t('season.noGroups'))}</p>`)
            + this.loose('season.alone', table.alone, true) + this.loose('season.unrecorded', table.unrecorded, false) + this.kept();
    }
    render() {
        const body = this.el('seasonBody');
        if (body) body.innerHTML = this.html();
    }
}
if (typeof UIManager !== 'undefined') UIManager.prototype.seasonPage = function () { return this._seasonPage || (this._seasonPage = new SeasonPage(this)); };
