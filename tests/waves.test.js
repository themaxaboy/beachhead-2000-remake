import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAVES, MAX_WAVES, sampleWaves, waveAttenuation, wavePhases, TAU } from '../src/world/waves.js';
import { travelTime, depthAtOffset } from '../src/world/ShoreField.js';

test('the wave set is sorted by amplitude and can never fold into loops', () => {
  assert.equal(WAVES.length, MAX_WAVES);
  for (let i = 1; i < WAVES.length; i++) assert.ok(WAVES[i].A <= WAVES[i - 1].A);
  // Sum of Q·k·A over the full set stays below 1 (Gerstner crests stay single-valued).
  const s = WAVES.reduce((acc, w) => acc + w.Q * w.k * w.A, 0);
  assert.ok(s < 1, `steepness sum ${s}`);
});

test('sampleWaves is deterministic and bounded by the amplitude sum', () => {
  const bound = WAVES.slice(0, 4).reduce((a, w) => a + w.A, 0);
  for (let i = 0; i < 200; i++) {
    const x = (i * 37.3) % 400 - 200;
    const z = -150 - ((i * 11.7) % 300);
    const a = sampleWaves(x, z, i * 0.37, 4, 10);
    const b = sampleWaves(x, z, i * 0.37, 4, 10);
    assert.deepEqual(a, b);
    assert.ok(Math.abs(a.y) <= bound + 1e-9);
  }
});

test('waves die in shallow water, long ones first, and vanish on the sand', () => {
  const long = WAVES[0];
  const short = WAVES[MAX_WAVES - 1];
  assert.equal(waveAttenuation(long, 10), 1);
  assert.ok(waveAttenuation(long, 1) < waveAttenuation(short, 1));
  assert.equal(waveAttenuation(long, 0), 0);
  assert.equal(waveAttenuation(short, -1), 0);
  const y = sampleWaves(0, -100, 3, 8, -0.5);
  assert.equal(y.y, 0);
});

test('wrapped GPU phases match the CPU phase', () => {
  const t = 12345.678;
  const ph = wavePhases(t);
  for (let i = 0; i < MAX_WAVES; i++) {
    const w = WAVES[i];
    const direct = w.phase - w.omega * t;
    assert.ok(ph[i] >= 0 && ph[i] < TAU);
    assert.ok(Math.abs(Math.sin(ph[i]) - Math.sin(direct)) < 1e-6);
  }
});

test('shore travel time is zero on land and grows offshore', () => {
  assert.equal(travelTime(5), 0);
  assert.equal(travelTime(0), 0);
  let prev = 0;
  for (const d of [-1, -5, -20, -60, -150, -400, -1500]) {
    const t = travelTime(d);
    assert.ok(t > prev, `T(${d}) = ${t}`);
    prev = t;
  }
  // Deep water (7.5 m) far out: waves move at ~sqrt(g h) = 8.6 m/s.
  const slope = (travelTime(-1500) - travelTime(-1000)) / 500;
  assert.ok(Math.abs(slope - 1 / Math.sqrt(9.81 * depthAtOffset(-1200))) < 0.01);
});
