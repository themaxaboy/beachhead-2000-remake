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
