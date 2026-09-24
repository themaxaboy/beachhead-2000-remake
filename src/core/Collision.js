import { segSphere } from './math.js';
import { heightAt } from '../world/Terrain.js';

/** Result object reused between casts (read it before the next cast). */
const R = { hit: false, t: 1, x: 0, y: 0, z: 0, kind: '', entity: null, soldier: -1, crate: null };

export class Collision {
  constructor(game) {
    this.game = game;
  }

  /**
   * Casts a segment through the world and returns the first thing it hits.
   * opts: { terrain, water, infantry, crates, entities, ignore }
   */
  segmentCast(x0, y0, z0, x1, y1, z1, opts = {}) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    let best = 1.0001;
    R.hit = false;
    R.kind = '';
    R.entity = null;
    R.soldier = -1;
    R.crate = null;

    if (opts.entities !== false) {
      for (const e of this.game.entities.list) {
        if (!e.solid || e.removed || e === opts.ignore) continue;
        const bt = segSphere(x0, y0, z0, dx, dy, dz, e.pos.x, e.pos.y, e.pos.z, e.radius + 1);
        if (bt < 0) continue;
        for (const s of e.worldSpheres) {
          const t = segSphere(x0, y0, z0, dx, dy, dz, s.x, s.y, s.z, s.r);
          if (t >= 0 && t < best) {
            best = t;
            R.kind = 'entity';
            R.entity = e;
          }
        }
      }
    }

    if (opts.infantry !== false) {
      const hit = this.game.infantry.segmentCast(x0, y0, z0, dx, dy, dz, best);
      if (hit.index >= 0) {
        best = hit.t;
        R.kind = 'soldier';
        R.soldier = hit.index;
        R.entity = null;
      }
    }

    if (opts.crates !== false) {
      for (const c of this.game.crates) {
        if (!c.active) continue;
        const t = segSphere(x0, y0, z0, dx, dy, dz, c.pos.x, c.pos.y, c.pos.z, 1.0);
        if (t >= 0 && t < best) {
          best = t;
          R.kind = 'crate';
          R.crate = c;
          R.entity = null;
          R.soldier = -1;
        }
      }
    }

    if (opts.terrain !== false) {
      const t = terrainCast(x0, y0, z0, dx, dy, dz, best);
      if (t >= 0 && t < best) {
        best = t;
        const x = x0 + dx * t;
        const z = z0 + dz * t;
        R.kind = heightAt(x, z) < 0.02 ? 'water' : 'terrain';
        R.entity = null;
        R.soldier = -1;
        R.crate = null;
      }
    }

    if (best <= 1) {
      R.hit = true;
      R.t = best;
      R.x = x0 + dx * best;
      R.y = y0 + dy * best;
      R.z = z0 + dz * best;
    }
    return R;
  }
}

/** Surface = max(terrain, sea level 0). Returns t of the first crossing, or -1. */
export function terrainCast(x0, y0, z0, dx, dy, dz, maxT = 1) {
  if (y0 > 40 && y0 + dy * maxT > 40) return -1;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const steps = Math.max(1, Math.min(64, Math.ceil((len * maxT) / 2.5)));
  let prevT = 0;
  let prevAbove = y0 - Math.max(0, heightAt(x0, z0));
  if (prevAbove < 0) return 0;
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * maxT;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    const z = z0 + dz * t;
    const above = y - Math.max(0, heightAt(x, z));
    if (above <= 0) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) / 2;
        const mx = x0 + dx * mid;
        const my = y0 + dy * mid;
        const mz = z0 + dz * mid;
        if (my - Math.max(0, heightAt(mx, mz)) > 0) lo = mid;
        else hi = mid;
      }
      return hi;
    }
    prevT = t;
    prevAbove = above;
  }
  return -1;
}
