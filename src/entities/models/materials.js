// Shared PBR materials + procedural canvas textures for all procedural models.
// Nothing here touches `document` at import time: canvas textures are generated lazily
// when createMaterials() is called (browser only; in a DOM-less context they fall back
// to plain colours).
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Small deterministic noise toolkit (tileable value noise + fbm)
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(seed, period) {
  const rnd = mulberry32(seed);
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = g[y0 * period + x0], b = g[y0 * period + x1];
    const c = g[y1 * period + x0], d = g[y1 * period + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

/** Tileable fBm sampler over [0,1)^2 -> ~[0,1]. */
export function makeFbm(seed, basePeriod = 4, octaves = 4, gain = 0.5) {
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push({ n: valueNoise(seed * 7919 + o * 104729, basePeriod << o), p: basePeriod << o });
  let norm = 0, amp = 1;
  for (let o = 0; o < octaves; o++) { norm += amp; amp *= gain; }
  return (u, v) => {
    let s = 0, a = 1;
    for (let o = 0; o < octaves; o++) { s += a * layers[o].n(u * layers[o].p, v * layers[o].p); a *= gain; }
    return s / norm;
  };
}

// ---------------------------------------------------------------------------
// Canvas texture helpers
// ---------------------------------------------------------------------------
function createCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

/**
 * Create a THREE.CanvasTexture of size w x h, drawn by drawFn(ctx, w, h).
 * Returns null when no canvas implementation is available (e.g. Node).
 * opts: { srgb = true, wrap = true, repeat: [x, y], anisotropy = 8 }
 */
export function makeCanvasTexture(w, h, drawFn, opts = {}) {
  const canvas = createCanvas(w, h);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  drawFn(ctx, w, h);
  const t = new THREE.CanvasTexture(canvas);
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.wrap !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
  t.anisotropy = opts.anisotropy ?? 8;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Per-pixel fill helper: fn(u, v, x, y) -> [r, g, b, a?] (0..255). */
function fillPixels(ctx, w, h, fn) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x / w, y / h, x, y);
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c.length > 3 ? c[3] : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

/** Neutral light worn-paint detail (multiplied with material colour). */
function wornPaintTexture() {
  const n1 = makeFbm(11, 4, 5), n2 = makeFbm(12, 16, 3);
  const rnd = mulberry32(99);
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    fillPixels(ctx, w, h, (u, v) => {
      const a = n1(u, v), b = n2(u, v);
      let l = 212 + (a - 0.5) * 60 + (b - 0.5) * 22;
      // streaks (vertical grime)
      l -= Math.max(0, n2(u * 0.25, v * 4) - 0.62) * 150;
      return [clamp255(l), clamp255(l), clamp255(l * 0.97)];
    });
    // scratches / chips
    ctx.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w, y = rnd() * h, l = 4 + rnd() * 26, a = rnd() * Math.PI;
      ctx.strokeStyle = rnd() < 0.5 ? 'rgba(255,255,245,0.35)' : 'rgba(60,45,30,0.35)';
      ctx.lineWidth = 0.6 + rnd() * 1.2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
    }
  });
}

/** Light panel-line + rivet texture for aircraft / ship skins (multiplied with colour; also used as bump). */
function panelTexture(seed = 5, lineDark = 150) {
  const n1 = makeFbm(seed, 4, 4), rnd = mulberry32(seed * 31);
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    fillPixels(ctx, w, h, (u, v) => {
      const l = 232 + (n1(u, v) - 0.5) * 26;
      return [l, l, l];
    });
    // panels: irregular grid
    const cols = [0], rows = [0];
    let x = 0; while (x < w - 40) { x += 60 + rnd() * 90; if (x < w - 30) cols.push(Math.round(x)); }
    let y = 0; while (y < h - 40) { y += 70 + rnd() * 110; if (y < h - 30) rows.push(Math.round(y)); }
    ctx.fillStyle = `rgb(${lineDark},${lineDark},${lineDark})`;
    for (const cx of cols) ctx.fillRect(cx, 0, 2, h);
    for (let r = 0; r < rows.length; r++) {
      // staggered horizontal seams
      for (let c = 0; c < cols.length; c++) {
        const x0 = cols[c], x1 = c + 1 < cols.length ? cols[c + 1] : w;
        const yy = (rows[r] + (c % 2 ? 23 : 0)) % h;
        ctx.fillRect(x0, yy, x1 - x0, 2);
      }
    }
    // rivet rows next to seams
    ctx.fillStyle = 'rgba(120,120,120,0.55)';
    for (const cx of cols) for (let yy = 4; yy < h; yy += 9) ctx.fillRect(cx + 5, yy, 1.5, 1.5);
    // a few darker access panels
    for (let i = 0; i < 6; i++) {
      const px = rnd() * w, py = rnd() * h, pw = 20 + rnd() * 40, ph = 16 + rnd() * 30;
      ctx.strokeStyle = `rgba(${lineDark},${lineDark},${lineDark},0.9)`; ctx.lineWidth = 1.5;
      ctx.strokeRect(px, py, pw, ph);
    }
  });
}

/** Camouflage: SEA scheme (tan / medium green / dark green) on top; the strip v<0.07 is underside light grey. */
function jetCamoTexture() {
  const nA = makeFbm(21, 3, 4, 0.45), nB = makeFbm(22, 3, 4, 0.45), nD = makeFbm(23, 32, 2);
  const tan = [158, 128, 92], green = [88, 96, 62], dark = [52, 60, 42], grey = [206, 206, 198];
  return makeCanvasTexture(1024, 1024, (ctx, w, h) => {
    fillPixels(ctx, w, h, (u, v) => {
      const detail = (nD(u, v) - 0.5) * 16;
      // canvas y=0 is top; texture v = 1 - y/h. Reserve bottom 7% (v<0.07) as underside.
      if (v > 0.93) return [grey[0] + detail, grey[1] + detail, grey[2] + detail];
      const a = nA(u, v), b = nB(u, v);
      const tTan = smooth(0.47, 0.5, a);
      const tDark = smooth(0.5, 0.53, b);
      const gcol = [mix(green[0], dark[0], tDark), mix(green[1], dark[1], tDark), mix(green[2], dark[2], tDark)];
      const c = [mix(gcol[0], tan[0], tTan), mix(gcol[1], tan[1], tTan), mix(gcol[2], tan[2], tTan)];
      return [clamp255(c[0] + detail), clamp255(c[1] + detail), clamp255(c[2] + detail)];
    });
    // subtle panel lines over the whole thing
    const rnd = mulberry32(77);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let i = 0; i < 26; i++) ctx.fillRect(rnd() * w, 0, 1.5, h * 0.93);
    for (let i = 0; i < 22; i++) ctx.fillRect(0, rnd() * h * 0.93, w, 1.5);
  });
}

/** Two-tone desert camo. */
function sandCamoTexture() {
  const nA = makeFbm(31, 3, 5, 0.5), nD = makeFbm(32, 32, 2);
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    fillPixels(ctx, w, h, (u, v) => {
      const a = nA(u, v), d = (nD(u, v) - 0.5) * 14;
      const t = smooth(0.52, 0.56, a);
      return [clamp255(mix(176, 112, t) + d), clamp255(mix(152, 88, t) + d), clamp255(mix(108, 58, t) + d)];
    });
  });
}

/** Track links: along v one link pitch; across u the track width. Grey metal with rubber pads. */
function trackTexture() {
  return makeCanvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#2a2927'; ctx.fillRect(0, 0, w, h); // steel shoe
    // rubber pads
    ctx.fillStyle = '#141414';
    ctx.fillRect(8, 16, 48, 84); ctx.fillRect(72, 16, 48, 84);
    // grouser bar (raised, worn shiny)
    const g = ctx.createLinearGradient(0, 100, 0, 116);
    g.addColorStop(0, '#55524c'); g.addColorStop(0.5, '#8a857c'); g.addColorStop(1, '#3a3834');
    ctx.fillStyle = g; ctx.fillRect(0, 102, w, 12);
    // end connectors
    ctx.fillStyle = '#4a4843'; ctx.fillRect(0, 0, 8, h); ctx.fillRect(w - 8, 0, 8, h); ctx.fillRect(58, 0, 12, h);
    // gap between links
    ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, w, 4);
  });
}

function burlapTexture() {
  const n = makeFbm(41, 8, 3);
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    fillPixels(ctx, w, h, (u, v, x, y) => {
      const wx = Math.sin((x / w) * Math.PI * 2 * 48), wy = Math.sin((y / h) * Math.PI * 2 * 48);
      const weave = (x + y) % 2 ? wx * 0.5 + 0.5 : wy * 0.5 + 0.5;
      const l = 0.78 + weave * 0.16 + (n(u, v) - 0.5) * 0.35;
      return [clamp255(190 * l), clamp255(165 * l), clamp255(118 * l)];
    });
  });
}

function planksTexture(base = [92, 96, 58], seed = 3) {
  const n = makeFbm(seed, 2, 5), rnd = mulberry32(seed);
  const offs = [0, 1, 2, 3, 4].map(() => rnd());
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    const plank = 5;
    fillPixels(ctx, w, h, (u, v) => {
      const pi = Math.floor(v * plank);
      const grain = Math.sin((u * 30 + n(u * 0.5 + offs[pi % 5], v * 3) * 10) * 3) * 0.5 + 0.5;
      const edge = Math.min(v * plank - pi, 1 - (v * plank - pi));
      const gap = edge < 0.025 ? 0.35 : edge < 0.06 ? 0.8 : 1;
      const l = (0.86 + grain * 0.1 + (n(u, v) - 0.5) * 0.25 + (offs[pi % 5] - 0.5) * 0.12) * gap;
      return [clamp255(base[0] * l), clamp255(base[1] * l), clamp255(base[2] * l)];
    });
  });
}

function crateFaceTexture(kind) {
  const n = makeFbm(kind === 'ammo' ? 51 : 52, 2, 5);
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    const base = [96, 100, 60];
    const plank = 4;
    fillPixels(ctx, w, h, (u, v) => {
      const pi = Math.floor(v * plank);
      const grain = Math.sin((u * 26 + n(u * 0.5 + pi * 0.3, v * 3) * 9) * 3) * 0.5 + 0.5;
      const e = Math.min(v * plank - pi, 1 - (v * plank - pi));
      const gap = e < 0.02 ? 0.35 : e < 0.05 ? 0.8 : 1;
      const l = (0.85 + grain * 0.1 + (n(u, v) - 0.5) * 0.25) * gap;
      return [clamp255(base[0] * l), clamp255(base[1] * l), clamp255(base[2] * l)];
    });
    const stencilWear = (alpha) => {
      // speckle the paint so it looks sprayed through a stencil
      const img = ctx.getImageData(0, 0, w, h);
      const r = mulberry32(5);
      for (let i = 0; i < 2500; i++) {
        const x = Math.floor(r() * w), y = Math.floor(r() * h), k = (y * w + x) * 4;
        img.data[k] = img.data[k] * alpha; img.data[k + 1] = img.data[k + 1] * alpha; img.data[k + 2] = img.data[k + 2] * alpha;
      }
      ctx.putImageData(img, 0, 0);
    };
    if (kind === 'ammo') {
      ctx.strokeStyle = '#e8b320'; ctx.lineWidth = 58; ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(60, 60); ctx.lineTo(452, 452); ctx.moveTo(452, 60); ctx.lineTo(60, 452); ctx.stroke();
      ctx.fillStyle = '#e8b320';
      ctx.font = 'bold 44px "Arial Black", Impact, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(20,20,10,0.85)'; ctx.fillRect(176, 226, 160, 60);
      ctx.fillStyle = '#e8b320'; ctx.fillText('AMMO', 256, 272);
    } else {
      ctx.fillStyle = '#e9e7de'; ctx.fillRect(96, 96, 320, 320);
      ctx.strokeStyle = '#2b2b22'; ctx.lineWidth = 6; ctx.strokeRect(96, 96, 320, 320);
      // shield emblem with red cross
      ctx.fillStyle = '#b3201c';
      ctx.beginPath();
      ctx.moveTo(256, 124); ctx.lineTo(372, 160); ctx.lineTo(362, 290);
      ctx.quadraticCurveTo(340, 360, 256, 396); ctx.quadraticCurveTo(172, 360, 150, 290); ctx.lineTo(140, 160); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f4f2ea';
      ctx.fillRect(236, 170, 40, 180); ctx.fillRect(176, 236, 160, 40);
    }
    stencilWear(0.82);
  });
}

function canopyClothTexture() {
  // Across u: gores (alternating white / olive panels). Along v: slight shading + seams.
  return makeCanvasTexture(512, 64, (ctx, w, h) => {
    const gores = 8; // texture repeats (1 per 2 gores) set by UV in geometry
    for (let i = 0; i < gores; i++) {
      ctx.fillStyle = i % 2 ? '#f0efe8' : '#5f6a3e';
      ctx.fillRect((i * w) / gores, 0, w / gores + 1, h);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i <= gores; i++) ctx.fillRect((i * w) / gores - 1, 0, 2, h);
    for (let j = 1; j < 4; j++) ctx.fillRect(0, (j * h) / 4, w, 1);
  }, { anisotropy: 4 });
}

function rotorBlurTexture() {
  return makeCanvasTexture(256, 256, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x + 0.5) / w * 2 - 1, dy = (y + 0.5) / h * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      let a = 0;
      if (r < 1 && r > 0.1) {
        a = 0.55 + 0.45 * smooth(0.1, 0.3, r);
        a *= 1 - smooth(0.93, 1.0, r);
        if (r > 0.88 && r < 0.92) a *= 1.6; // tip stripe
        a *= 0.85 + 0.15 * Math.sin(r * 90);
      }
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = clamp255(a * 255); img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, { srgb: false, wrap: false });
}

function perforatedTexture() {
  // alpha map: white = solid, black = hole.
  return makeCanvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    const nx = 4, ny = 4;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const cx = ((i + (j % 2 ? 0.5 : 0)) + 0.5) * (w / nx), cy = (j + 0.5) * (h / ny);
      ctx.beginPath(); ctx.ellipse(cx % w, cy, w / nx * 0.3, h / ny * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    }
  }, { srgb: false });
}

function concreteFallback() {
  const n = makeFbm(61, 4, 6), rnd = mulberry32(61);
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    fillPixels(ctx, w, h, (u, v) => {
      const l = 150 + (n(u, v) - 0.5) * 70;
      return [clamp255(l), clamp255(l * 0.96), clamp255(l * 0.9)];
    });
    ctx.fillStyle = 'rgba(40,40,40,0.4)';
    for (let i = 0; i < 400; i++) { const r = rnd() * 2.5; ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, r, 0, 7); ctx.fill(); }
  });
}

function rustFallback() {
  const n = makeFbm(71, 4, 6);
  return makeCanvasTexture(512, 512, (ctx, w, h) => {
    fillPixels(ctx, w, h, (u, v) => {
      const a = n(u, v);
      return [clamp255(120 + a * 90), clamp255(60 + a * 45), clamp255(28 + a * 18)];
    });
  });
}

// ---------------------------------------------------------------------------
// Decal atlas (hull numbers, roundel, tail codes). Rects in canvas pixels (1024 x 512).
// ---------------------------------------------------------------------------
export const DECAL_ATLAS_SIZE = [1024, 512];
export const DECALS = {
  num217: [0, 0, 256, 128],
  num34: [256, 0, 256, 128],
  num508: [512, 0, 256, 128],
  num12: [768, 0, 256, 128],
  numL62: [0, 128, 256, 128],
  num09: [256, 128, 256, 128],
  roundel: [512, 128, 256, 256],
  tailCode: [0, 256, 512, 128],
  noStep: [768, 128, 256, 64],
  stripe: [768, 192, 256, 64],
  rescue: [0, 384, 256, 128],
};
/** UV rect [u0, v0, u1, v1] of a decal in the atlas (flipY texture). */
export function decalUV(name) {
  const r = DECALS[name] || DECALS.num217;
  const [W, H] = DECAL_ATLAS_SIZE;
  return [r[0] / W, 1 - (r[1] + r[3]) / H, (r[0] + r[2]) / W, 1 - r[1] / H];
}

function decalAtlasTexture() {
  const [W, H] = DECAL_ATLAS_SIZE;
  return makeCanvasTexture(W, H, (ctx) => {
    ctx.clearRect(0, 0, W, H);
    const stencil = (name, text, color = '#e9e6dc', size = 92) => {
      const [x, y, w, h] = DECALS[name];
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = `bold ${size}px "Arial Narrow", "Arial Black", Impact, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x + w / 2, y + h / 2 + 4);
      // stencil bridges
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillRect(x, y + h / 2 - 3, w, 5);
      ctx.restore();
    };
    stencil('num217', '217'); stencil('num34', '34'); stencil('num508', '508'); stencil('num12', '12');
    stencil('numL62', 'L-62'); stencil('num09', '09');
    // Generic friendly roundel: blue disc, white star
    {
      const [x, y, w, h] = DECALS.roundel;
      const cx = x + w / 2, cy = y + h / 2, R = w / 2 - 6;
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1f3f8f'; ctx.beginPath(); ctx.arc(cx, cy, R - 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.beginPath();
      const r1 = R * 0.9, r2 = r1 * 0.382;
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? r2 : r1;
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
    }
    {
      const [x, y, w, h] = DECALS.tailCode;
      ctx.fillStyle = '#23262a'; ctx.font = 'bold 76px "Arial Narrow", Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('AF 62-1795', x + w / 2, y + h / 2 + 4);
    }
    {
      const [x, y, w, h] = DECALS.noStep;
      ctx.fillStyle = '#23262a'; ctx.font = 'bold 34px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('NO STEP', x + w / 2, y + h / 2);
    }
    {
      const [x, y, w, h] = DECALS.stripe;
      for (let i = -2; i < 14; i++) {
        ctx.fillStyle = i % 2 ? '#1a1a1a' : '#e3b21f';
        ctx.beginPath(); ctx.moveTo(x + i * 24, y); ctx.lineTo(x + i * 24 + 24, y); ctx.lineTo(x + i * 24 + 24 - h, y + h); ctx.lineTo(x + i * 24 - h, y + h); ctx.fill();
      }
      ctx.clearRect(x - 80, y, 80, h); ctx.clearRect(x + w, y, 80, h);
    }
    {
      const [x, y, w, h] = DECALS.rescue;
      ctx.fillStyle = '#d8d8d0'; ctx.font = 'bold 60px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('RESCUE', x + w / 2, y + h / 2);
    }
  }, { wrap: false });
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
function validSet(s) {
  if (!s || typeof s !== 'object') return null;
  const ok = (t) => t && t.isTexture;
  if (!ok(s.map) && !ok(s.normalMap) && !ok(s.roughnessMap)) return null;
  return { map: ok(s.map) ? s.map : null, normalMap: ok(s.normalMap) ? s.normalMap : null, roughnessMap: ok(s.roughnessMap) ? s.roughnessMap : null };
}

/** Linear-space colour from sRGB 0..255 components. */
function srgb(r, g, b) { return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace); }

// Average linear colour of the Poly Haven green_metal_rust diffuse (measured), used to tint it.
const GMR_AVG = [0.0499, 0.0738, 0.0342];
function tintForGmr(r, g, b) {
  const c = srgb(r, g, b);
  return new THREE.Color().setRGB(c.r / GMR_AVG[0], c.g / GMR_AVG[1], c.b / GMR_AVG[2]);
}

export function createMaterials(tex = {}) {
  const gmr = validSet(tex && tex.greenMetalRust);
  const rm = validSet(tex && tex.rustyMetal);
  const cc = validSet(tex && tex.concrete);

  const worn = wornPaintTexture();
  const panels = panelTexture(5, 150);
  const panelsDark = panelTexture(9, 120);

  const std = (p) => new THREE.MeshStandardMaterial(p);

  // Military paint over steel: gmr textures tinted, or procedural worn paint.
  const paint = (r, g, b, extra = {}) => {
    if (gmr) {
      return std({
        color: gmr.map ? tintForGmr(r, g, b) : srgb(r, g, b),
        map: gmr.map, normalMap: gmr.normalMap, roughnessMap: gmr.roughnessMap,
        normalScale: new THREE.Vector2(0.8, 0.8),
        roughness: gmr.roughnessMap ? 1.45 : 0.72, metalness: 0.22, ...extra,
      });
    }
    return std({ color: srgb(r * 1.18, g * 1.18, b * 1.18), map: worn, bumpMap: worn, bumpScale: 0.6, roughness: 0.74, metalness: 0.2, ...extra });
  };

  const m = {};
  m.olive = paint(70, 74, 46);
  m.olive2 = paint(50, 55, 37);
  const sandTex = sandCamoTexture();
  m.sandCamo = std({ color: 0xffffff, map: sandTex, normalMap: gmr?.normalMap ?? null, roughnessMap: gmr?.roughnessMap ?? null, roughness: gmr?.roughnessMap ? 1.5 : 0.8, metalness: 0.15, normalScale: new THREE.Vector2(0.8, 0.8) });
  if (!sandTex) m.sandCamo.color = srgb(170, 146, 104);

  m.navyGrey = std({ color: srgb(126, 134, 140), map: panelsDark, bumpMap: panelsDark, bumpScale: 0.5, roughness: 0.62, metalness: 0.3 });
  m.deckGrey = std({ color: srgb(88, 92, 94), map: worn, bumpMap: worn, bumpScale: 1.2, roughness: 0.88, metalness: 0.15 });
  m.aircraftGrey = std({ color: srgb(178, 183, 186), map: panels, bumpMap: panels, bumpScale: 0.35, roughness: 0.5, metalness: 0.28 });
  const camo = jetCamoTexture();
  m.jetCamo = std({ color: camo ? 0xffffff : srgb(110, 112, 78), map: camo, bumpMap: panels, bumpScale: 0.25, roughness: 0.58, metalness: 0.18 });
  m.bomberGrey = std({ color: srgb(152, 157, 160), map: panels, bumpMap: panels, bumpScale: 0.35, roughness: 0.42, metalness: 0.55 });
  m.bomberDark = std({ color: srgb(40, 42, 44), map: panels, roughness: 0.6, metalness: 0.3 });
  m.helicopterGreen = std({ color: srgb(70, 78, 56), map: panels, bumpMap: panels, bumpScale: 0.3, roughness: 0.66, metalness: 0.18 });
  m.darkMetal = std({ color: srgb(58, 60, 62), map: worn, roughness: 0.36, metalness: 0.85 });
  m.blackMetal = std({ color: srgb(24, 25, 26), map: worn, roughness: 0.5, metalness: 0.6 });
  m.brass = std({ color: srgb(196, 150, 70), roughness: 0.3, metalness: 1.0 });
  m.rubber = std({ color: srgb(28, 28, 28), roughness: 0.92, metalness: 0.0 });
  const tr = trackTexture();
  m.track = std({ color: 0xffffff, map: tr, bumpMap: tr, bumpScale: 2.0, roughness: 0.78, metalness: 0.45 });
  if (!tr) m.track.color = srgb(40, 40, 38);
  m.glass = new THREE.MeshPhysicalMaterial({
    color: srgb(40, 58, 66), metalness: 0.0, roughness: 0.04, transparent: true, opacity: 0.55,
    envMapIntensity: 2.5, clearcoat: 1.0, clearcoatRoughness: 0.03, specularIntensity: 1.0, depthWrite: false,
  });
  m.lens = std({ color: srgb(220, 220, 205), roughness: 0.08, metalness: 0.6, emissive: srgb(40, 38, 30) });
  m.rotor = std({ color: srgb(40, 42, 44), roughness: 0.55, metalness: 0.35 });
  const blurA = rotorBlurTexture();
  m.rotorBlur = std({ color: srgb(34, 36, 38), transparent: true, opacity: 0.25, alphaMap: blurA, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.2 });
  m.engineGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.42, 0.1).multiplyScalar(4.0), toneMapped: false });
  m.charred = std({ color: srgb(14, 13, 12), roughness: 1.0, metalness: 0.0 });

  // soldier
  m.uniform = std({ color: srgb(88, 96, 62), roughness: 0.95, metalness: 0 });
  m.uniformDark = std({ color: srgb(58, 64, 42), roughness: 0.95, metalness: 0 });
  m.skin = std({ color: srgb(190, 140, 110), roughness: 0.7, metalness: 0 });
  m.helmet = std({ color: srgb(74, 82, 52), roughness: 0.82, metalness: 0.05, map: worn });
  m.boots = std({ color: srgb(38, 30, 24), roughness: 0.75, metalness: 0 });
  m.webbing = std({ color: srgb(112, 108, 76), roughness: 0.95, metalness: 0 });
  m.rifle = std({ color: srgb(30, 30, 30), roughness: 0.55, metalness: 0.5 });
  m.soldier = std({ color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0.02 });
  m.glove = std({ color: srgb(62, 56, 44), roughness: 0.8, metalness: 0, map: worn, bumpMap: worn, bumpScale: 1.5 });
  m.sleeve = std({ color: srgb(80, 88, 58), roughness: 0.95, metalness: 0, map: worn, bumpMap: worn, bumpScale: 2 });

  // props
  const cloth = canopyClothTexture();
  m.canopyCloth = std({ color: cloth ? 0xffffff : srgb(200, 200, 190), map: cloth, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
  m.cord = std({ color: srgb(200, 196, 180), roughness: 0.9, metalness: 0 });
  const wood = planksTexture([120, 110, 78], 3);
  m.crateWood = std({ color: 0xffffff, map: wood, roughness: 0.85, metalness: 0 });
  if (!wood) m.crateWood.color = srgb(120, 110, 78);
  const ammo = crateFaceTexture('ammo');
  m.crateAmmo = std({ color: ammo ? 0xffffff : srgb(96, 100, 60), map: ammo, roughness: 0.8, metalness: 0 });
  const shield = crateFaceTexture('shield');
  m.crateShield = std({ color: shield ? 0xffffff : srgb(230, 228, 220), map: shield, roughness: 0.8, metalness: 0 });
  const burlap = burlapTexture();
  m.sandbag = std({ color: burlap ? 0xffffff : srgb(180, 158, 112), map: burlap, bumpMap: burlap, bumpScale: 2.5, roughness: 0.97, metalness: 0 });
  if (rm) {
    m.hedgehog = std({ map: rm.map, normalMap: rm.normalMap, roughnessMap: rm.roughnessMap, roughness: rm.roughnessMap ? 1.6 : 0.8, metalness: 0.45, color: srgb(200, 180, 170) });
  } else {
    const rust = rustFallback();
    m.hedgehog = std({ color: rust ? 0xffffff : srgb(120, 64, 34), map: rust, bumpMap: rust, bumpScale: 1, roughness: 0.85, metalness: 0.4 });
  }
  m.wire = std({ color: srgb(70, 66, 60), roughness: 0.55, metalness: 0.8 });
  if (cc) {
    m.concrete = std({ color: 0xffffff, map: cc.map, normalMap: cc.normalMap, roughnessMap: cc.roughnessMap, roughness: cc.roughnessMap ? 1.9 : 0.9, metalness: 0 });
  } else {
    const ct = concreteFallback();
    m.concrete = std({ color: ct ? 0xffffff : srgb(150, 146, 136), map: ct, bumpMap: ct, bumpScale: 1, roughness: 0.92, metalness: 0 });
  }
  m.markingWhite = std({ color: srgb(225, 222, 210), roughness: 0.7, metalness: 0 });
  m.markingYellow = std({ color: srgb(220, 170, 40), roughness: 0.6, metalness: 0 });
  m.markingRed = std({ color: srgb(170, 30, 25), roughness: 0.6, metalness: 0 });
  const perf = perforatedTexture();
  m.perforated = std({ color: srgb(48, 50, 52), roughness: 0.42, metalness: 0.8, alphaMap: perf, alphaTest: perf ? 0.5 : 0, side: THREE.DoubleSide, map: worn });
  const atlas = decalAtlasTexture();
  m.decals = std({
    color: 0xffffff, map: atlas, alphaTest: 0.45, roughness: 0.7, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, visible: !!atlas,
  });
  m.interior = std({ color: srgb(58, 62, 56), roughness: 0.9, metalness: 0.1 });

  for (const [k, mat] of Object.entries(m)) mat.name = k;
  return m;
}

const _origMaterials = new WeakMap();

/** Swap every mesh material in a hierarchy to mats.charred (for wrecks). Glass/blur/glow/decal meshes are hidden. */
export function applyCharred(root, mats) {
  const skip = new Set(['glass', 'rotorBlur', 'engineGlow', 'decals', 'lens']);
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (!_origMaterials.has(o)) _origMaterials.set(o, { material: o.material, visible: o.visible });
    const k = o.material && o.material.name;
    if (skip.has(k)) o.visible = false;
    else o.material = mats.charred;
  });
  return root;
}

/** Restore materials swapped by applyCharred. */
export function restoreMaterials(root) {
  root.traverse((o) => {
    const s = o.isMesh && _origMaterials.get(o);
    if (s) { o.material = s.material; o.visible = s.visible; _origMaterials.delete(o); }
  });
  return root;
}

export const charMaterialFor = (mesh, mats) => { mesh.material = mats.charred; return mesh; };
