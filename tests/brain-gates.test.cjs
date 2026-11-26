// The rule-based brain builds inside the gates every seat meets (b1271, asp67
// 26 November 2026): the tech that unlocks a building, and the age it belongs to. Its
// build function checked cost and spacing only, and the callers asked for the academy,
// the temple and the stable properly but not for the rest: an anchor raised houses,
// farms and a barracks without the research a model's seat pays for first, and an
// archery range in the stone age.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm');
const { createMatch } = require('../tools/bench/realm.cjs');

const AGES = ['stone', 'neolithic', 'bronze', 'iron'];

test('no anchor ever stands a building it has not researched or reached the age for', async () => {
    for (const [seed, seats] of [['gates-1', ['greek', 'egyptian']], ['gates-2', [{ civ: 'maya', type: 'ki', profile: 'raider' }, { civ: 'viking', type: 'ki', profile: 'turtle' }]]]) {
        const m = await createMatch({ kind: 'arena', seed, seats, mapSize: 800 });
        const def = type => vm.runInContext(`getBuildingDef(${JSON.stringify(type)})`, m.context);
        const needAge = (civ, type) => vm.runInContext(`effectiveBuildingAge(${JSON.stringify(civ)}, getBuildingDef(${JSON.stringify(type)}))`, m.context);
        const seen = new Set();
        for (let t = 0; t < 900; t++) {
            m.advance(1000);
            for (const ai of m.seats) for (const b of ai.buildings) {
                if (seen.has(b) || b.isWonder) continue;
                seen.add(b);
                const d = def(b.type);
                if (!d) continue;
                const where = `${seed} ${ai.civilization} at ${t + 1} s: ${b.type}`;
                if (d.requiresTech) assert.ok(ai.researchedTechs[d.requiresTech], where + ' without the tech "' + d.requiresTech + '"');
                assert.ok(AGES.indexOf(ai.age) >= AGES.indexOf(needAge(ai.civilization, b.type)), where + ' in the ' + ai.age + ' age');
            }
        }
        // ...and the gates do not stop it: it researches what it needs and builds on.
        for (const ai of m.seats) {
            const types = new Set(ai.buildings.map(b => b.type));
            for (const need of ['house', 'farm', 'barracks'])
                assert.ok(types.has(need), `${seed} ${ai.civilization} (${ai.profile}) has a ${need} after fifteen minutes: ${[...types].join(', ')}`);
        }
    }
});
