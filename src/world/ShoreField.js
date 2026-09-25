import * as THREE from 'three';
import { heightAt, shoreZ } from './Terrain.js';
import { SHORE_CYCLE } from './shaders/shore.glsl.js';

// Baked data for the shore shaders, sampled in world space:
//   R = terrain height (m)          -> water depth for colour, wave attenuation and the surf zone
//   G = wave travel time to shore (s) -> phase of the breakers, so crests line up with the depth contours
//   B = X component of the wave heading (shore normal), A = spare
// tidewater (MIT) solves an Eikonal equation over its island; our beach is a single curved shoreline whose
// seabed depends only on the distance offshore, so the travel time is a 1-D integral: T(d) = ∫ dz / sqrt(g·h).

const G = 9.81;
export const SHORE_RECT = { x0: -1536, z0: -704, w: 3072, h: 768 };
const RES_X = 1024;
const RES_Z = 256;
const STEP = 0.5;
const MAX_D = 2400;

/** Still-water depth at a signed distance `d` from the shoreline (negative = offshore). */
export function depthAtOffset(d) {
  return -heightAt(0, shoreZ(0) + d);
}

let table = null;
function travelTable() {
  if (table) return table;
  const n = Math.ceil(MAX_D / STEP) + 1;
  table = new Float32Array(n);
  let t = 0;
  let prev = 1 / Math.sqrt(G * 0.25);
  for (let i = 1; i < n; i++) {
    const depth = Math.min(25, Math.max(0.25, depthAtOffset(-i * STEP)));
    const inv = 1 / Math.sqrt(G * depth);
    t += ((prev + inv) / 2) * STEP;
    prev = inv;
    table[i] = t;
  }
  return table;
}

/** Seconds a shallow-water wave needs from offset `d` (m, negative offshore) to reach the shoreline. */
export function travelTime(d) {
  if (d >= 0) return 0;
  const tab = travelTable();
  const f = Math.min(-d / STEP, tab.length - 1.001);
  const i = Math.floor(f);
  return tab[i] + (tab[i + 1] - tab[i]) * (f - i);
}

/** Bakes the shore texture (≈3 m per texel). */
export function bakeShoreField() {
  const data = new Uint16Array(RES_X * RES_Z * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;
  const { x0, z0, w, h } = SHORE_RECT;
  for (let i = 0; i < RES_X; i++) {
    const x = x0 + ((i + 0.5) / RES_X) * w;
    const zc = shoreZ(x);
    // Shore normal from the slope of the shoreline curve: waves turn to meet the beach head on.
    const dzdx = (shoreZ(x + 2) - shoreZ(x - 2)) / 4;
    const len = Math.hypot(dzdx, 1);
    const dirX = -dzdx / len;
    for (let j = 0; j < RES_Z; j++) {
      const z = z0 + ((j + 0.5) / RES_Z) * h;
      const o = (j * RES_X + i) * 4;
      data[o] = toHalf(heightAt(x, z));
      data[o + 1] = toHalf(Math.min(travelTime(z - zc), 120));
      data[o + 2] = toHalf(dirX);
      data[o + 3] = toHalf(0);
    }
  }
  const tex = new THREE.DataTexture(data, RES_X, RES_Z, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Uniform values describing where the texture sits in the world. */
export function shoreRectUniform() {
  const { x0, z0, w, h } = SHORE_RECT;
  return new THREE.Vector4(x0, z0, 1 / w, 1 / h);
}

/** Shared shore uniforms (ocean + terrain) and the clock that drives them. */
export function createShore({ period = 9, amplitude = 0.45, runup = 0.6 } = {}) {
  const uniforms = {
    uShoreTex: { value: bakeShoreField() },
    uShoreRect: { value: shoreRectUniform() },
    uShore: { value: new THREE.Vector4(period, amplitude, runup, 1) },
    uShoreTime: { value: 0 },
  };
  let time = 0;
  return {
    uniforms,
    update(dt) {
      time += dt;
      // Everything wave-index dependent repeats every SHORE_CYCLE waves, so wrapping here is seamless.
      uniforms.uShoreTime.value = time % (SHORE_CYCLE * uniforms.uShore.value.x);
    },
  };
}
