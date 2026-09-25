// Graphics tier selection and dynamic resolution. Pure logic (no three.js) so it can be unit tested.

export const TIERS = ['low', 'medium', 'high', 'ultra'];
export const QUALITY_OPTIONS = ['auto', ...TIERS];

/** Reads the unmasked GPU name (falls back to the masked one). */
export function gpuName(gl) {
  if (!gl) return '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch {
    return '';
  }
}

/**
 * Best guess of a starting tier from the GPU name. Auto never picks ultra: it is opt-in.
 * Unknown GPUs start at medium and the runtime governor corrects from there.
 */
export function guessTier({ renderer = '', cores = 8, pixels = 1920 * 1080 } = {}) {
  const r = renderer.toLowerCase();
  let tier = 'medium';
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic/.test(r)) tier = 'low';
  else if (/mali|adreno|powervr|videocore|tegra/.test(r)) tier = 'low';
  else if (/intel/.test(r)) tier = /iris|\barc\b|\bxe\b/.test(r) ? 'medium' : 'low';
  else if (/geforce|nvidia|quadro|rtx|gtx/.test(r)) tier = /\bmx ?\d|gt \d|geforce \d{3}m?\b/.test(r) ? 'medium' : 'high';
  else if (/radeon|amd/.test(r)) tier = /\b(rx|pro w|vii)\b/.test(r) && !/vega (3|6|7|8|9|10|11)\b/.test(r) ? 'high' : 'medium';
  else if (/apple/.test(r)) tier = /(pro|max|ultra)\b/.test(r) ? 'high' : 'medium';
  // Few cores usually means a low-power laptop, and huge screens need more fill rate.
  if (cores <= 2 && tier !== 'low') tier = 'low';
  if (pixels > 3000 * 1800 && tier === 'high') tier = 'medium';
  return tier;
}

export function lowerTier(tier) {
  const i = TIERS.indexOf(tier);
  return i > 0 ? TIERS[i - 1] : tier;
}

/**
 * Adjusts the render scale to hold the frame rate. Frame times are smoothed; the scale steps down fast
 * when frames are slow and creeps back up only after a long steady stretch, with a cooldown between steps
 * (every step reallocates render targets).
 */
export class DynamicResolution {
  constructor({ min = 0.5, max = 1, targetMs = 1000 / 60, step = 0.1, cooldown = 1.5, upAfter = 3 } = {}) {
    this.min = min;
    this.max = max;
    this.targetMs = targetMs;
    this.step = step;
    this.cooldown = cooldown;
    this.upAfter = upAfter;
    this.reset(max);
  }

  reset(scale = this.max) {
    this.scale = Math.min(this.max, Math.max(this.min, scale));
    this.ema = this.targetMs;
    this.wait = this.cooldown;
    this.good = 0;
  }

  setRange(min, max) {
    this.min = min;
    this.max = max;
    this.reset(Math.min(max, Math.max(min, this.scale)));
  }

  /** Feeds one frame time in ms. Returns the new scale when it changed, otherwise null. */
  sample(ms) {
    if (!(ms > 0) || ms > 100) return null; // tab switches, loading hitches
    this.ema += (ms - this.ema) * 0.08;
    this.wait -= ms / 1000;
    const slow = this.ema > this.targetMs * 1.15;
    // Vsync caps the frame time at the target, so "fast enough" means "at the cap".
    this.good = this.ema < this.targetMs * 1.04 ? this.good + ms / 1000 : 0;
    if (this.wait > 0) return null;
    let next = this.scale;
    if (slow && this.scale > this.min) next = Math.max(this.min, this.scale - this.step);
    else if (this.good > this.upAfter && this.scale < this.max) next = Math.min(this.max, this.scale + this.step * 0.5);
    if (next === this.scale) return null;
    this.scale = Math.round(next * 100) / 100;
    this.wait = this.cooldown;
    this.good = 0;
    this.ema = this.targetMs;
    return this.scale;
  }
}

/** Recommends a lower tier when the frame rate stays poor even at the lowest render scale. */
export class TierGovernor {
  constructor({ minFps = 40, after = 8 } = {}) {
    this.minFps = minFps;
    this.after = after;
    this.reset();
  }

  reset() {
    this.bad = 0;
    this.ema = 1000 / 60;
  }

  /** Returns true once when a downgrade is recommended. */
  sample(ms, atMinScale) {
    if (!(ms > 0) || ms > 100) return false;
    this.ema += (ms - this.ema) * 0.05;
    if (atMinScale && this.ema > 1000 / this.minFps) this.bad += ms / 1000;
    else this.bad = Math.max(0, this.bad - ms / 2000);
    if (this.bad > this.after) {
      this.reset();
      return true;
    }
    return false;
  }
}
