'use strict';
// What a browser would make of a string of HTML, as far as an attack through it goes: the
// tags, their attributes, and the code of their inline event handlers, decoded as the
// parser decodes them. The project takes no dependencies, so this is the small part of an
// HTML tokenizer those questions need -- start tags and attributes, quoted or not.
const vm = require('node:vm');

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : m;
    });
}

// [{ tag, attrs: [{ name, value }] }] for every start tag in the string.
function tags(html) {
    const out = [], s = String(html), n = s.length, ws = c => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
    let i = 0;
    while (i < n) {
        if (s[i] !== '<' || !/[a-zA-Z]/.test(s[i + 1] || '')) { i++; continue; }
        let j = i + 1;
        while (j < n && !ws(s[j]) && s[j] !== '>' && s[j] !== '/') j++;
        const el = { tag: s.slice(i + 1, j).toLowerCase(), attrs: [] };
        for (;;) {
            while (j < n && (ws(s[j]) || s[j] === '/')) j++;
            if (j >= n || s[j] === '>') break;
            let k = j;
            while (k < n && !ws(s[k]) && s[k] !== '=' && s[k] !== '>' && s[k] !== '/') k++;
            const name = s.slice(j, k).toLowerCase();
            j = k;
            while (j < n && ws(s[j])) j++;
            let value = '';
            if (s[j] === '=') {
                j++;
                while (j < n && ws(s[j])) j++;
                if (s[j] === '"' || s[j] === "'") {
                    const q = s[j]; k = s.indexOf(q, j + 1); if (k < 0) k = n;
                    value = s.slice(j + 1, k); j = Math.min(n, k + 1);
                } else {
                    k = j; while (k < n && !ws(s[k]) && s[k] !== '>') k++;
                    value = s.slice(j, k); j = k;
                }
            }
            if (name) el.attrs.push({ name, value: decode(value) });
        }
        out.push(el);
        i = j + 1;
    }
    return out;
}

// Runs every inline handler of the HTML as a click would, in a world where everything the
// page offers exists and does nothing, and `xssFired` records being called. Returns
// { fired, broken }: what hostile code ran, and which handlers are not even valid code
// (an unescaped quote from a value breaks the handler it sits in before it attacks).
function runHandlers(html) {
    const fired = [], broken = [];
    const anything = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : anything), apply: () => anything, construct: () => anything });
    for (const el of tags(html)) for (const a of el.attrs) {
        if (!a.name.startsWith('on')) continue;
        const ctx = vm.createContext({ xssFired: n => { fired.push(n); }, alert: n => { fired.push(n); }, game: anything, event: anything, window: anything, document: anything });
        let fn;
        try { fn = vm.runInContext('(function(event){' + a.value + '\n})', ctx); }
        catch (e) { broken.push(`<${el.tag} ${a.name}>: ${a.value.slice(0, 120)}`); continue; }
        try { fn.call(anything, anything); } catch (e) { /* a name the stand-in world lacks: not an attack */ }
    }
    return { fired, broken };
}

module.exports = { tags, runHandlers, decode };
