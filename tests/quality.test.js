import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessTier, lowerTier, DynamicResolution, TierGovernor, TIERS } from '../src/core/Quality.js';

test('guessTier maps common GPU names to tiers', () => {
  const cases = [
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
    ['ANGLE (Intel, Mesa Intel(R) HD Graphics 520 (SKL GT2), OpenGL 4.6)', 'low'],
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'low'],
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['ANGLE (NVIDIA, NVIDIA GeForce MX150 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon RX Vega 10 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['Apple M1', 'medium'],
    ['Apple M2 Max', 'high'],
    ['Mali-G78', 'low'],
    ['', 'medium'],
  ];
  for (const [name, want] of cases) assert.equal(guessTier({ renderer: name }), want, name);
});

test('guessTier never picks ultra and respects weak CPUs and huge screens', () => {
  assert.equal(guessTier({ renderer: 'NVIDIA GeForce RTX 4090', cores: 16 }), 'high');
  assert.equal(guessTier({ renderer: 'NVIDIA GeForce RTX 4090', cores: 2 }), 'low');
  assert.equal(guessTier({ renderer: 'NVIDIA GeForce RTX 3060', pixels: 3840 * 2160 }), 'medium');
});

test('lowerTier steps down and stops at low', () => {
  assert.deepEqual(TIERS.map(lowerTier), ['low', 'low', 'medium', 'high']);
});

test('DynamicResolution steps down when slow, honours cooldown and the minimum', () => {
  const d = new DynamicResolution({ min: 0.5, max: 1, cooldown: 1 });
  const changes = [];
  for (let i = 0; i < 400; i++) {
    const r = d.sample(40); // 25 fps
    if (r !== null) changes.push(r);
  }
  assert.deepEqual(changes, [0.9, 0.8, 0.7, 0.6, 0.5]);
  assert.equal(d.scale, 0.5);
  // Never below the minimum.
  for (let i = 0; i < 200; i++) assert.equal(d.sample(40), null);
});

test('DynamicResolution creeps back up only after a steady stretch at the vsync cap', () => {
  const d = new DynamicResolution({ min: 0.5, max: 1, cooldown: 1, upAfter: 3 });
  d.reset(0.6);
  let t = 0;
  let first = null;
  while (t < 10 && first === null) {
    const r = d.sample(16.7);
    t += 0.0167;
    if (r !== null) first = { r, t };
  }
  assert.ok(first, 'scale should rise');
  assert.equal(first.r, 0.65);
  assert.ok(first.t > 3, `rose too early at ${first.t}s`);
});

test('DynamicResolution ignores hitches and bad samples', () => {
  const d = new DynamicResolution({ min: 0.5, max: 1, cooldown: 0 });
  for (let i = 0; i < 50; i++) assert.equal(d.sample(500), null);
  assert.equal(d.sample(NaN), null);
  assert.equal(d.scale, 1);
});

test('TierGovernor recommends a drop only after a sustained bad stretch at the minimum scale', () => {
  const g = new TierGovernor({ minFps: 40, after: 2 });
  let fired = 0;
  for (let i = 0; i < 100; i++) if (g.sample(40, false)) fired++;
  assert.equal(fired, 0, 'not at minimum scale yet');
  let t = 0;
  while (!g.sample(40, true) && t < 10) t += 0.04;
  assert.ok(t >= 1.9 && t < 3, `fired after ${t}s`);
  // Recovering frame rates drain the counter again.
  for (let i = 0; i < 40; i++) g.sample(40, true);
  for (let i = 0; i < 400; i++) assert.equal(g.sample(16, true), false);
});
