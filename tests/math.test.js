import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segSphere, interceptTime, wrapAngle, bearingOf, bearingDir } from '../src/core/math.js';

test('segSphere hits and misses', () => {
  // segment along +X through a sphere at (5,0,0) r=1
  const t = segSphere(0, 0, 0, 10, 0, 0, 5, 0, 0, 1);
  assert.ok(Math.abs(t - 0.4) < 1e-9);
  assert.equal(segSphere(0, 3, 0, 10, 0, 0, 5, 0, 0, 1), -1);
  assert.equal(segSphere(0, 0, 0, 2, 0, 0, 5, 0, 0, 1), -1); // too short
});

test('interceptTime solves a simple lead', () => {
  // target 100 m ahead moving sideways at 10 m/s, projectile 100 m/s
  const t = interceptTime(100, 0, 0, 0, 0, 10, 100);
  assert.ok(t > 1 && t < 1.01);
});

test('angles and bearings', () => {
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9 || Math.abs(wrapAngle(3 * Math.PI) + Math.PI) < 1e-9);
  assert.ok(Math.abs(bearingOf(0, -10)) < 1e-9); // straight to sea
  assert.ok(Math.abs(bearingOf(10, 0) - Math.PI / 2) < 1e-9); // right
  const d = bearingDir(Math.PI / 2);
  assert.ok(Math.abs(d.x - 1) < 1e-9 && Math.abs(d.z) < 1e-9);
});
