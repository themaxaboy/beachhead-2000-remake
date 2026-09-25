import * as THREE from 'three';
import { fbm2 } from '../core/math.js';

// Procedurally generated effect textures (built lazily in the browser, cached).
const cache = {};

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finish(c, srgb = false) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** 2x2 atlas of soft, noisy smoke puffs. RGB = self-shading, A = density. */
export function makeSmokeAtlas() {
  if (cache.smoke) return cache.smoke;
  const S = 128;
  const c = canvas(S * 2, S * 2);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S * 2, S * 2);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S;
    const oy = Math.floor(cell / 2) * S;
    const seed = cell * 17.3;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S - 0.5;
        const v = (y + 0.5) / S - 0.5;
        const r = Math.sqrt(u * u + v * v) * 2;
        const n = fbm2(u * 4.5 + seed, v * 4.5 - seed, 5) * 0.5 + 0.5;
        let a = Math.max(0, 1 - r * (0.75 + 0.5 * (1 - n)));
        a = Math.pow(a, 1.3) * (0.55 + 0.9 * n);
        a = Math.min(1, a);
        // fake lighting from the top
        const shade = 0.62 + 0.38 * Math.min(1, Math.max(0, 0.5 - v * 1.4 + (n - 0.5) * 0.6));
        const i = ((oy + y) * S * 2 + ox + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(shade * 255);
        img.data[i + 3] = Math.round(a * 255);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.smoke = finish(c);
  return cache.smoke;
}

/** Soft radial glow. */
export function makeGlowTexture() {
  if (cache.glow) return cache.glow;
  const c = canvas(128, 128);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  cache.glow = finish(c);
  return cache.glow;
}

/** Star-shaped muzzle flash with rays. */
export function makeFlashTexture() {
  if (cache.flash) return cache.flash;
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  ctx.translate(S / 2, S / 2);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, S / 2);
  g.addColorStop(0, 'rgba(255,255,240,1)');
  g.addColorStop(0.15, 'rgba(255,230,160,0.95)');
  g.addColorStop(0.4, 'rgba(255,150,40,0.45)');
  g.addColorStop(1, 'rgba(255,90,0,0)');
  ctx.fillStyle = g;
  const rays = 7;
  for (let k = 0; k < 2; k++) {
    ctx.beginPath();
    for (let i = 0; i < rays * 2; i++) {
      const a = (i / (rays * 2)) * Math.PI * 2 + k * 0.4;
      const r = i % 2 === 0 ? S * (0.42 + Math.random() * 0.08) : S * 0.11;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.2, 0, Math.PI * 2);
  ctx.fill();
  cache.flash = finish(c);
  return cache.flash;
}

/** Side-on muzzle flash (elongated cone) for the first-person guns. */
export function makeFlashSideTexture() {
  if (cache.flashSide) return cache.flashSide;
  const W = 256;
  const H = 128;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  for (let i = 0; i < 26; i++) {
    const len = W * (0.35 + Math.random() * 0.6);
    const w = H * (0.08 + Math.random() * 0.22);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, 'rgba(255,255,230,0.9)');
    g.addColorStop(0.35, 'rgba(255,190,90,0.55)');
    g.addColorStop(1, 'rgba(255,100,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    const off = (Math.random() - 0.5) * H * 0.2;
    ctx.moveTo(0, H / 2 - w * 0.4 + off * 0.2);
    ctx.quadraticCurveTo(len * 0.5, H / 2 - w + off, len, H / 2 + off);
    ctx.quadraticCurveTo(len * 0.5, H / 2 + w + off, 0, H / 2 + w * 0.4 + off * 0.2);
    ctx.fill();
  }
  cache.flashSide = finish(c);
  return cache.flashSide;
}

/** Dark blast mark for the ground. */
export function makeScorchTexture() {
  if (cache.scorch) return cache.scorch;
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S - 0.5;
      const v = y / S - 0.5;
      const r = Math.sqrt(u * u + v * v) * 2;
      const ang = Math.atan2(v, u);
      const n = fbm2(Math.cos(ang) * 2 + 5, Math.sin(ang) * 2 + 5, 4) * 0.5 + 0.5;
      const edge = 0.55 + 0.4 * n;
      let a = 1 - smooth(edge * 0.55, edge, r);
      const grain = fbm2(u * 30, v * 30, 3) * 0.5 + 0.5;
      a *= 0.75 + 0.25 * grain;
      const i = (y * S + x) * 4;
      const dark = 18 + grain * 20;
      img.data[i] = dark + 6;
      img.data[i + 1] = dark + 3;
      img.data[i + 2] = dark;
      img.data[i + 3] = Math.round(Math.min(1, a) * 235);
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.scorch = finish(c, true);
  return cache.scorch;
}

/** Expanding ring for shockwaves and water rings. */
export function makeRingTexture() {
  if (cache.ring) return cache.ring;
  const c = canvas(256, 256);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 60, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.7)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  cache.ring = finish(c);
  return cache.ring;
}

/** Dune grass blades on a transparent background. */
export function makeGrassTexture() {
  if (cache.grass) return cache.grass;
  const W = 128;
  const H = 128;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  for (let i = 0; i < 38; i++) {
    const x0 = 10 + Math.random() * (W - 20);
    const h = H * (0.45 + Math.random() * 0.55);
    const lean = (Math.random() - 0.5) * 40;
    const shade = 90 + Math.random() * 70;
    ctx.strokeStyle = `rgb(${shade + 40},${shade + 35},${shade * 0.55})`;
    ctx.lineWidth = 1.2 + Math.random() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, H);
    ctx.quadraticCurveTo(x0 + lean * 0.3, H - h * 0.6, x0 + lean, H - h);
    ctx.stroke();
  }
  cache.grass = finish(c, true);
  return cache.grass;
}

function smooth(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------ tileable noise for the sea

function thash(ix, iy, P, seed) {
  ix = ((ix % P) + P) % P;
  iy = ((iy % P) + P) % P;
  let h = Math.imul(ix + seed * 131, 374761393) + Math.imul(iy - seed * 71, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Periodic value noise in [0,1]; period P cells. */
function tnoise(x, y, P, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = thash(ix, iy, P, seed);
  const b = thash(ix + 1, iy, P, seed);
  const c = thash(ix, iy + 1, P, seed);
  const d = thash(ix + 1, iy + 1, P, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Periodic fBm in [0,1] over a unit tile (u, v in 0..1), base frequency f cells. */
function tfbm(u, v, f, octaves, seed = 0) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tnoise(u * f, v * f, f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Periodic Worley F1 distance (in cell units) over a unit tile with n cells. */
function tworley(u, v, n, seed = 0) {
  const x = u * n;
  const y = v * n;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i;
      const cy = iy + j;
      const px = cx + thash(cx, cy, n, seed);
      const py = cy + thash(cx, cy, n, seed + 5);
      const d = Math.hypot(px - x, py - y);
      if (d < best) best = d;
    }
  }
  return best;
}

function dataTexture(data, S) {
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * Tileable sea foam, after the FoamTexture of dgreenheck/tidewater (MIT): a domain-warped fBm "raft" density
 * torn open by three layers of Worley holes, so thresholding it by coverage grows lace that rips and dissolves.
 * R = lace density, G = fine bubbles, B = mottle.
 */
export function makeFoamTexture(S = 256) {
  const key = `foam${S}`;
  if (cache[key]) return cache[key];
  const data = new Uint8Array(S * S * 4);
  const sat = (v) => Math.min(1, Math.max(0, v));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const wx = tfbm(u, v, 4, 3, 11) - 0.5;
      const wy = tfbm(u, v, 4, 3, 23) - 0.5;
      const uw = (u + wx * 0.12 + 1) % 1;
      const vw = (v + wy * 0.12 + 1) % 1;
      const n = tfbm(uw, vw, 6, 4, 3);
      const dens = smooth(0.28, 0.66, n);
      const holeA = smooth(0.5, 0.22, tworley(uw, vw, 7, 1) + (n - 0.5) * 0.3);
      const holeB = smooth(0.46, 0.18, tworley(uw, vw, 17, 2) + (n - 0.5) * 0.3);
      const holeC = smooth(0.42, 0.12, tworley(uw, vw, 41, 3));
      const holes = holeA + holeB * 0.8 + holeC * 0.6;
      const bub = 1 - smooth(0.0, 0.35, tworley(u, v, 61, 4));
      const foam = sat(dens * 1.45 - holes * 0.75 + bub * 0.06);
      const o = (y * S + x) * 4;
      data[o] = foam * 255;
      data[o + 1] = bub * 255;
      data[o + 2] = tfbm(u, v, 8, 3, 7) * 255;
      data[o + 3] = 255;
    }
  }
  cache[key] = dataTexture(data, S);
  return cache[key];
}

/**
 * Large-scale sea variation, sampled over hundreds of metres (after tidewater's SeaDetail): R = wind gusts
 * ("cat's paws", rougher and darker water), G = glassy slicks (long bands, calmer), B = fine mottle.
 */
export function makeSeaDetailTexture(S = 128) {
  if (cache.seaDetail) return cache.seaDetail;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const gust = tfbm(u, v, 4, 4, 41);
      // Slicks: noise stretched 8:1 along the wind by sampling a squashed domain, then banded.
      const sl = tfbm(u, (v * 8) % 1, 2, 3, 57) * 0.6 + tfbm(u, v, 8, 2, 63) * 0.4;
      const o = (y * S + x) * 4;
      data[o] = gust * 255;
      data[o + 1] = smooth(0.58, 0.72, sl) * 255;
      data[o + 2] = tfbm(u, v, 16, 2, 77) * 255;
      data[o + 3] = 255;
    }
  }
  cache.seaDetail = dataTexture(data, S);
  return cache.seaDetail;
}
