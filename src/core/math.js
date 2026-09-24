// Pure math helpers. Bearings are measured clockwise from the sea (-Z): bearing 0 = straight out to sea,
// 90 = right (+X), 180 = inland (+Z).

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a, b, v) => {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
};

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Exponential smoothing factor independent of frame rate. */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

export function moveTowardsAngle(current, target, maxDelta) {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Bearing (radians) of a point as seen from the origin. */
export const bearingOf = (x, z) => Math.atan2(x, -z);

/** Unit XZ vector for a bearing. */
export const bearingDir = (b) => ({ x: Math.sin(b), z: -Math.cos(b) });

/** Heading angle (three.js rotation.y) that points a +Z-forward model along direction (dx, dz). */
export const headingTo = (dx, dz) => Math.atan2(dx, dz);

/**
 * Segment-sphere intersection. Returns the parametric t in [0,1] of the first hit, or -1.
 * p0 + t * (p1 - p0).
 */
export function segSphere(p0x, p0y, p0z, dx, dy, dz, cx, cy, cz, r) {
  const mx = p0x - cx;
  const my = p0y - cy;
  const mz = p0z - cz;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return -1;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c <= 0) return 0; // starts inside
  if (b > 0) return -1;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1 ? t : -1;
}

/**
 * Lead solution: time until a projectile of speed s fired from the origin meets a target at relative
 * position p moving with velocity v. Returns -1 if unreachable.
 */
export function interceptTime(px, py, pz, vx, vy, vz, s) {
  const a = vx * vx + vy * vy + vz * vz - s * s;
  const b = 2 * (px * vx + py * vy + pz * vz);
  const c = px * px + py * py + pz * pz;
  if (Math.abs(a) < 1e-6) return c > 0 && b < 0 ? -c / b : -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  const t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  return t > 0 ? t : -1;
}

/** 2D value noise (deterministic, smooth) used by the terrain. */
function hash2(ix, iy) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise2(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
}

export function fbm2(x, y, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
