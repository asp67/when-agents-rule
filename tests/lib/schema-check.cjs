// A small JSON Schema checker for game-state-schema.json, written in-repo because the
// project takes no dependencies. It implements exactly the keywords that schema uses
// and throws on any other one, so a schema edit that relies on something unimplemented
// fails loudly instead of being checked by nothing.
'use strict';
const ANNOTATIONS = new Set(['$schema', 'title', 'description', '$defs']);
const KNOWN = new Set(['type', 'required', 'properties', 'enum', 'const', '$ref', 'oneOf', 'items',
    'additionalProperties', 'minimum', 'maximum', ...ANNOTATIONS]);

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}
const typeMatches = (want, v) => {
    const t = typeOf(v);
    return want === t || (want === 'number' && t === 'integer');
};

function check(root, schema, value, at, errors) {
    for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`schema keyword "${k}" at ${at} is not implemented`);
    if (schema.$ref) {
        // Any local JSON pointer ("#/$defs/cost", "#/properties/enemyBuildings/items").
        if (!schema.$ref.startsWith('#/')) throw new Error(`non-local $ref ${schema.$ref} at ${at}`);
        let target = root;
        for (const part of schema.$ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
            target = target && typeof target === 'object' ? target[part] : undefined;
        }
        if (!target || typeof target !== 'object') throw new Error(`unresolvable $ref ${schema.$ref} at ${at}`);
        return check(root, target, value, at, errors);
    }
    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some(t => typeMatches(t, value))) { errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`); return; }
    }
    if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: ${value} < minimum ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: ${value} > maximum ${schema.maximum}`);
    }
    if (schema.oneOf) {
        const passing = schema.oneOf.filter(s => { const e = []; check(root, s, value, at, e); return !e.length; }).length;
        if (passing !== 1) errors.push(`${at}: matches ${passing} of the oneOf branches, expected exactly 1`);
    }
    if (typeOf(value) === 'object') {
        for (const r of schema.required || []) if (!(r in value)) errors.push(`${at}: missing required "${r}"`);
        const props = schema.properties || {};
        for (const [k, v] of Object.entries(value)) {
            if (props[k]) check(root, props[k], v, at + '.' + k, errors);
            else if (schema.additionalProperties === false) errors.push(`${at}: undocumented property "${k}"`);
            else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(root, schema.additionalProperties, v, at + '.' + k, errors);
        }
    }
    if (typeOf(value) === 'array' && schema.items) value.forEach((v, i) => check(root, schema.items, v, `${at}[${i}]`, errors));
}

// Returns a list of problems; empty means the value conforms.
function validate(schema, value) { const errors = []; check(schema, schema, value, '$', errors); return errors; }
// Top-level keys the state emits that the schema does not document at all.
function undocumented(schema, value) { return Object.keys(value || {}).filter(k => !(schema.properties || {})[k]); }
module.exports = { validate, undocumented };
