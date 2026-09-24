import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allLevels, generateLevel, levelFileText, LEVEL_COUNT } from '../src/data/levels.js';

test('there are 60 deterministic levels', () => {
  const levels = allLevels();
  assert.equal(levels.length, LEVEL_COUNT);
  assert.equal(LEVEL_COUNT, 60);
  assert.deepEqual(generateLevel(17), generateLevel(17));
});

test('aggression values stay within the original 1..9 range', () => {
  for (const def of allLevels()) {
    for (const v of Object.values(def.aggression)) {
      assert.ok(Number.isInteger(v) && v >= 1 && v <= 9, `level ${def.number}: ${v}`);
    }
  }
  assert.deepEqual(Object.values(generateLevel(1).aggression), [1, 1, 1, 1]);
  assert.deepEqual(Object.values(generateLevel(60).aggression), [9, 9, 9, 9]);
});

test('level 1 is an infantry-only introduction', () => {
  const def = generateLevel(1);
  assert.equal(def.units.tanks, 0);
  assert.equal(def.units.jets, 0);
  assert.equal(def.units.cobras, 0);
  assert.equal(def.schedule[0].kind, 'lct');
  assert.equal(def.schedule[0].cargo, 'infantry');
  assert.equal(def.timeOfDay, 'day');
});

test('unit counts and ammo never decrease with level', () => {
  const levels = allLevels();
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1];
    const b = levels[i];
    for (const k of ['infantryLCT', 'tanks', 'apcs', 'jets', 'cobras', 'ch53', 'bomberRaids']) {
      assert.ok(b.units[k] >= a.units[k], `${k} decreased at level ${b.number}`);
    }
    assert.ok(b.ammo.bullets >= a.ammo.bullets);
    assert.ok(b.timeLimit >= a.timeLimit);
  }
});

test('schedule fits inside the time limit and matches the unit counts', () => {
  for (const def of allLevels()) {
    const lcts = def.schedule.filter((e) => e.kind === 'lct');
    assert.equal(lcts.length, def.units.infantryLCT + def.units.tanks + def.units.apcs);
    assert.equal(def.schedule.filter((e) => e.kind === 'jet').length, def.units.jets);
    assert.equal(def.schedule.filter((e) => e.kind === 'cobra').length, def.units.cobras);
    assert.equal(def.schedule.filter((e) => e.kind === 'ch53').length, def.units.ch53);
    for (const e of def.schedule) {
      assert.ok(e.t >= 0 && e.t <= def.timeLimit * 0.75 + 1e-9, `level ${def.number} event at ${e.t}`);
      if (e.kind === 'lct') assert.ok(e.zone >= 0 && e.zone < def.zones.length);
    }
    assert.ok(def.zones.length >= 1);
    // weapons needed by the level have ammo
    if (def.units.tanks + def.units.apcs > 0) assert.ok(def.ammo.projectiles > 0);
    assert.ok(def.ammo.missiles > 0);
  }
});

test('level file text mirrors the original format', () => {
  const text = levelFileText(generateLevel(1));
  assert.match(text, /^Ammo \d+ \d+ \d+$/m);
  assert.match(text, /^Aggression 1 1 1 1$/m);
  assert.match(text, /^Time \d+$/m);
});
