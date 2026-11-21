#!/usr/bin/env node
// The season table of recorded matches (overhaul step C7; zero dependencies, Node 18+).
//
//   node tools/eval/season.cjs samples                     every .jsonl in a folder
//   node tools/eval/season.cjs a.jsonl b.jsonl             or files by name
//   node tools/eval/season.cjs samples --json              the table as JSON
//   node tools/eval/season.cjs samples --write samples/season.json
//                                                          the entries, for the Season page
//
// A model's results are added up only with results under the same declared conditions
// and the same scoring scale (js/eval/season.js, js/conditions.js). Every other set of
// conditions is a group of its own, and a seat whose conditions were not recorded is
// listed and compared with nothing. A mean has a 95 % interval from two matches on; no
// model is called ahead on one match, or while the intervals touch.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..', '..');
const WarEval = require(path.join(ROOT, 'js/eval/ledger.js'));
const WarSeason = require(path.join(ROOT, 'js/eval/season.js'));

// The comparability rule itself, loaded as the page loads it: never a second copy.
function loadConditions() {
    const ctx = vm.createContext({});
    for (const f of ['js/manifest.js', 'js/sha256.js', 'js/conditions.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    return vm.runInContext('WarConditions', ctx);
}

function filesOf(args) {
    const out = [];
    for (const a of args) {
        if (!fs.existsSync(a)) { console.error('No such file or folder: ' + a); process.exitCode = 1; continue; }
        if (fs.statSync(a).isDirectory()) out.push(...fs.readdirSync(a).filter(f => f.endsWith('.jsonl')).sort().map(f => path.join(a, f)));
        else out.push(a);
    }
    return out;
}

function entriesOf(files, { source = 'file' } = {}) {
    const conditions = loadConditions(), entries = [];
    for (const file of files) {
        const e = WarSeason.entryOf(fs.readFileSync(file, 'utf8'), { evaluator: WarEval, conditions, source, file: path.basename(file) });
        if (e) entries.push(e); else console.error('Not a match transcript: ' + file);
    }
    return entries;
}

const cell = x => x.mean == null ? '-' : x.n < 2 ? x.mean.toFixed(1) + ' (1 match)' : x.mean.toFixed(1) + ' [' + x.lo.toFixed(1) + ' to ' + x.hi.toFixed(1) + ']';
const signed = v => (v > 0 ? '+' : '') + v.toFixed(1);
function grid(rows) {
    const width = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
    return rows.map(r => r.map((v, c) => c === 0 ? String(v).padEnd(width[c]) : String(v).padStart(width[c])).join('  ')).join('\n');
}

function report(t) {
    const L = WarSeason.label, out = [t.matches + ' matches: ' + t.groups.length + ' sets of conditions with something to add up or compare'
        + (t.alone.length ? ', ' + t.alone.length + ' seats alone under theirs' : '')
        + (t.unrecorded.length ? ', ' + t.unrecorded.length + ' seats without recorded conditions' : ''), ''];
    const loose = (title, rows, first) => {
        out.push(title);
        out.push(grid([['', first, 'build', 'placed'].concat(WarSeason.PARTS)].concat(rows.map(u =>
            [u.name || u.model || '?', u.cond || '-', u.build == null ? '-' : u.build, u.rank == null ? '-' : u.rank + ' of ' + u.of].concat(WarSeason.PARTS.map(p => u.scores[p] == null ? '-' : u.scores[p].toFixed(1)))))));
        out.push('');
    };
    for (const g of t.groups) {
        out.push('CONDITIONS ' + g.id + '   ' + g.protocol + ', build ' + (g.builds.join(', ') || 'not recorded') + ', scale ' + g.scale + ', ' + g.matches + (g.matches === 1 ? ' match' : ' matches'));
        out.push(grid([['', 'matches', 'first'].concat(WarSeason.PARTS)].concat(g.models.map(m =>
            [L(m.key), m.matches, m.firsts].concat(WarSeason.PARTS.map(p => cell(m.parts[p]) + (g.leaders[p] === m.key ? ' *' : '')))))));
        const led = WarSeason.PARTS.filter(p => g.leaders[p]);
        out.push(g.models.length < 2 ? 'One model under these conditions: nothing to compare it with.'
            : led.length ? '* ahead of every other model here: the intervals do not touch. Elsewhere: not separated yet.'
                : g.models.some(m => m.matches < 2) ? 'Not separated yet: at least two matches a model are needed before anything is called ahead.'
                    : 'Not separated yet: the intervals touch.');
        for (const h of g.headToHead) out.push('  ' + L(h.a) + ' v ' + L(h.b) + ': met ' + h.met + ', ' + L(h.a) + ' placed above ' + h.aAhead + ', ' + L(h.b) + ' ' + h.bAhead);
        for (const s of g.swaps) {
            const d = s.diff.index;
            out.push('  seat-swapped: ' + L(s.a) + ' minus ' + L(s.b) + ' on the Index, ' + s.pairs + (s.pairs === 1 ? ' pair: ' : ' pairs: ')
                + (d.mean == null ? '-' : signed(d.mean) + (d.n < 2 ? ' (one pair, no interval)' : ' [' + signed(d.lo) + ' to ' + signed(d.hi) + ']' + (WarSeason.apartFromZero(d) ? '' : ', not separated'))));
        }
        out.push('');
    }
    if (t.alone.length) loose('ALONE UNDER THEIR CONDITIONS   one match each, and no other model shared them: nothing to add up, nothing to compare', t.alone, 'conditions');
    if (t.unrecorded.length) loose('CONDITIONS NOT RECORDED   listed, compared with nothing', t.unrecorded, 'conditions');
    out.push('A mean is over matches, with a 95 % interval from two matches on. Scores are the evaluation profile\'s (docs/SCORING.md).');
    return out.join('\n');
}

function main(argv) {
    const flags = new Set(argv.filter(a => a.startsWith('--'))), at = argv.indexOf('--write');
    const target = at >= 0 ? argv[at + 1] : null;
    const files = filesOf(argv.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1)));
    if (!files.length || flags.has('--help')) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
        process.exitCode = files.length ? 0 : 2;
        return;
    }
    const entries = entriesOf(files, { source: target ? 'sample' : 'file' });
    if (target) {
        fs.writeFileSync(target, JSON.stringify({ kind: 'war-season-entries/1', scale: WarEval.SCALE, entries }, null, 1) + '\n');
        console.log('wrote ' + entries.length + ' entries to ' + target);
        return;
    }
    const table = WarSeason.table(entries);
    console.log(flags.has('--json') ? JSON.stringify(table, null, 1) : report(table));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { loadConditions, entriesOf, report, filesOf };
