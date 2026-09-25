import * as THREE from 'three';
import { buildSoldierParts, buildParachute } from './models/index.js';
import { heightAt } from '../world/Terrain.js';
import { segSphere, clamp, lerp, wrapAngle, bearingOf } from '../core/math.js';
import { rng } from '../core/rng.js';
import { UNITS } from '../data/units.js';

export const S_FREE = 0;
export const S_CARRIED = 1; // riding in a landing craft (visible)
export const S_ADVANCE = 2;
export const S_PRONE = 3; // dropped and firing
export const S_ASSAULT = 4; // reached the bunker perimeter
export const S_DYING = 5;
export const S_DEAD = 6;
export const S_CHUTE = 7;
export const S_FALLING = 8; // shot while under a parachute

const MAX = 240;
const _m = new THREE.Matrix4();
const _base = new THREE.Matrix4();
const _torso = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const HALF_PI = Math.PI / 2;

function rot(x, y, z) {
  _e.set(x, y, z, 'YXZ');
  return _tmp.makeRotationFromEuler(_e);
}

/** Data-oriented soldiers rendered with one InstancedMesh per body part. */
export class InfantrySystem {
  constructor(game) {
    this.game = game;
    this.state = new Uint8Array(MAX);
    this.x = new Float32Array(MAX);
    this.y = new Float32Array(MAX);
    this.z = new Float32Array(MAX);
    this.heading = new Float32Array(MAX);
    this.speed = new Float32Array(MAX);
    this.hp = new Float32Array(MAX);
    this.timer = new Float32Array(MAX);
    this.fireTimer = new Float32Array(MAX);
    this.grenadeTimer = new Float32Array(MAX);
    this.phase = new Float32Array(MAX);
    this.anim = new Float32Array(MAX); // 0..1 transition (prone / death)
    this.tx = new Float32Array(MAX);
    this.tz = new Float32Array(MAX);
    this.wx = new Float32Array(MAX); // intermediate waypoint (landing craft ramp)
    this.wz = new Float32Array(MAX);
    this.hasWaypoint = new Uint8Array(MAX);
    this.vy = new Float32Array(MAX);
    this.deathDir = new Float32Array(MAX);
    this.seed = new Float32Array(MAX);
    this.carrier = new Array(MAX).fill(null);
    this.slot = new Int16Array(MAX);
    this.chute = new Array(MAX).fill(null);
    this.alive = 0;
    this.deadList = [];

    const { parts } = buildSoldierParts(game.mats);
    this.parts = parts.map((p) => {
      const mesh = new THREE.InstancedMesh(p.geometry, p.material, MAX);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.layers.set(1); // not needed in the water reflection
      game.scene.add(mesh);
      return { name: p.name, mesh, pivot: p.pivot.clone() };
    });
    this.byName = Object.fromEntries(this.parts.map((p) => [p.name, p]));
    this.hipY = (this.byName.torso?.pivot.y ?? 0.95) || 0.95;
    this.chutePool = [];
  }

  reset() {
    this.state.fill(S_FREE);
    for (let i = 0; i < MAX; i++) this.releaseChute(i);
    this.carrier.fill(null);
    this.alive = 0;
    for (const p of this.parts) p.mesh.count = 0;
  }

  get aliveCount() {
    return this.alive;
  }

  allocate() {
    for (let i = 0; i < MAX; i++) {
      if (this.state[i] === S_FREE) return i;
    }
    // recycle the oldest corpse
    for (let i = 0; i < MAX; i++) {
      if (this.state[i] === S_DEAD) {
        this.state[i] = S_FREE;
        return i;
      }
    }
    return -1;
  }

  init(i, x, z, heading) {
    this.x[i] = x;
    this.z[i] = z;
    this.y[i] = heightAt(x, z);
    this.heading[i] = heading;
    this.hp[i] = UNITS.infantry.hp;
    this.phase[i] = rng.range(0, 6.28);
    this.seed[i] = rng.range(0, 100);
    this.anim[i] = 0;
    this.speed[i] = rng.range(2.6, 3.5);
    const p = this.game.level.progress;
    this.fireTimer[i] = rng.range(1.5, 4);
    this.grenadeTimer[i] = rng.range(4, lerp(12, 6, p));
    this.timer[i] = rng.range(3, 6);
    this.hasWaypoint[i] = 0;
    this.carrier[i] = null;
    this.alive++;
  }

  /** Picks an assault position on the bunker perimeter, roughly in line with where the soldier is. */
  assignTarget(i) {
    let b = bearingOf(this.x[i], this.z[i]) + rng.range(-0.25, 0.25);
    b = clamp(b, -1.45, 1.45);
    const r = rng.range(23, 33);
    this.tx[i] = Math.sin(b) * r;
    this.tz[i] = -Math.cos(b) * r;
  }

  /** Soldier sitting in a landing craft slot. */
  spawnCarried(carrier, slot) {
    const i = this.allocate();
    if (i < 0) return -1;
    this.init(i, carrier.pos.x, carrier.pos.z, carrier.yaw);
    this.state[i] = S_CARRIED;
    this.carrier[i] = carrier;
    this.slot[i] = slot;
    return i;
  }

  /** Soldier leaving a vehicle / craft and running for the bunker. */
  disembark(i, wx, wz) {
    this.state[i] = S_ADVANCE;
    this.carrier[i] = null;
    this.wx[i] = wx;
    this.wz[i] = wz;
    this.hasWaypoint[i] = 1;
    this.assignTarget(i);
    this.timer[i] = rng.range(3.5, 6);
  }

  spawnRunning(x, z, heading, wx, wz) {
    const i = this.allocate();
    if (i < 0) return -1;
    this.init(i, x, z, heading);
    this.disembark(i, wx ?? x, wz ?? z);
    return i;
  }

  spawnParatrooper(x, y, z) {
    const i = this.allocate();
    if (i < 0) return -1;
    this.init(i, x, z, Math.PI + rng.range(-0.5, 0.5));
    this.y[i] = y;
    this.vy[i] = 0;
    this.state[i] = S_CHUTE;
    this.anim[i] = 0;
    this.timer[i] = 0;
    this.chute[i] = this.takeChute();
    return i;
  }

  takeChute() {
    let c = this.chutePool.pop();
    if (!c) {
      c = buildParachute(this.game.mats, 3.2, false);
      c.root.traverse((o) => {
        if (o.isMesh) o.castShadow = true;
      });
    }
    c.root.visible = true;
    c.root.scale.setScalar(0.05);
    this.game.scene.add(c.root);
    return c;
  }

  releaseChute(i) {
    const c = this.chute[i];
    if (!c) return;
    this.game.scene.remove(c.root);
    this.chutePool.push(c);
    this.chute[i] = null;
  }

  // ------------------------------------------------------------------ combat

  damage(i, cls, amount, fromX, fromZ) {
    const st = this.state[i];
    if (st === S_FREE || st === S_DYING || st === S_DEAD || st === S_FALLING) return false;
    this.hp[i] -= amount;
    if (this.hp[i] > 0) return false;
    this.kill(i, cls, fromX, fromZ);
    return true;
  }

  kill(i, cls, fromX = 0, fromZ = 0) {
    const st = this.state[i];
    if (st === S_FREE || st === S_DYING || st === S_DEAD || st === S_FALLING) return;
    this.alive--;
    this.carrier[i] = null;
    if (st === S_CHUTE) {
      this.state[i] = S_FALLING;
      this.vy[i] = -2;
    } else {
      this.state[i] = S_DYING;
      this.anim[i] = st === S_PRONE ? 1 : 0;
    }
    // fall away from the shot
    const away = Math.atan2(this.x[i] - fromX, this.z[i] - fromZ);
    this.deathDir[i] = wrapAngle(away - this.heading[i]);
    this.timer[i] = 0;
    this.game.onInfantryKill(i, cls, this.x[i], this.y[i] + 1, this.z[i]);
  }

  /** Kills every soldier riding in a destroyed carrier. */
  killCarried(carrier, cls) {
    for (let i = 0; i < MAX; i++) {
      if (this.carrier[i] === carrier && this.state[i] === S_CARRIED) {
        this.kill(i, cls, carrier.pos.x, carrier.pos.z);
        this.anim[i] = 0.2;
      }
    }
  }

  releaseCarried(carrier, fn) {
    const list = [];
    for (let i = 0; i < MAX; i++) {
      if (this.carrier[i] === carrier && this.state[i] === S_CARRIED) list.push(i);
    }
    return list;
  }

  /** Splash damage from explosions. Returns the number of kills. */
  splash(x, y, z, radius, cls) {
    let kills = 0;
    const r2 = radius * radius;
    for (let i = 0; i < MAX; i++) {
      const st = this.state[i];
      if (st === S_FREE || st === S_DYING || st === S_DEAD || st === S_FALLING) continue;
      const dx = this.x[i] - x;
      const dy = this.y[i] + 0.8 - y;
      const dz = this.z[i] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const k = 1 - Math.sqrt(d2) / radius;
      if (k > 0.25 || rng.chance(k * 3)) {
        this.kill(i, cls, x, z);
        kills++;
      }
    }
    return kills;
  }

  sphereOf(i, out) {
    const st = this.state[i];
    const h = this.heading[i];
    if (st === S_PRONE && this.anim[i] > 0.5) {
      out.x = this.x[i];
      out.y = this.y[i] + 0.3;
      out.z = this.z[i];
      out.r = 0.62;
    } else if (st === S_CHUTE) {
      out.x = this.x[i];
      out.y = this.y[i] + 1.0;
      out.z = this.z[i];
      out.r = 0.65;
    } else {
      out.x = this.x[i] + Math.sin(h) * 0.05;
      out.y = this.y[i] + 1.05;
      out.z = this.z[i] + Math.cos(h) * 0.05;
      out.r = 0.58;
    }
    return out;
  }

  segmentCast(x0, y0, z0, dx, dy, dz, maxT) {
    const res = this._res || (this._res = { t: 1, index: -1 });
    const s = this._s || (this._s = { x: 0, y: 0, z: 0, r: 0 });
    res.t = maxT;
    res.index = -1;
    for (let i = 0; i < MAX; i++) {
      const st = this.state[i];
      if (st === S_FREE || st === S_DYING || st === S_DEAD || st === S_FALLING) continue;
      this.sphereOf(i, s);
      const t = segSphere(x0, y0, z0, dx, dy, dz, s.x, s.y, s.z, s.r);
      if (t >= 0 && t < res.t) {
        res.t = t;
        res.index = i;
      }
    }
    return res;
  }

  /** Nearest living soldier to a ray (used by the debug bot and aim assist tests). */
  forEachAlive(fn) {
    for (let i = 0; i < MAX; i++) {
      const st = this.state[i];
      if (st !== S_FREE && st !== S_DYING && st !== S_DEAD && st !== S_FALLING) fn(i);
    }
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    const game = this.game;
    const p = game.level.progress;
    const burstInterval = lerp(4.8, 2.0, p);
    const hitChance = lerp(0.14, 0.4, p);
    for (let i = 0; i < MAX; i++) {
      const st = this.state[i];
      if (st === S_FREE) continue;
      switch (st) {
        case S_CARRIED: {
          const c = this.carrier[i];
          if (!c || c.removed) {
            this.kill(i, 'mg');
            break;
          }
          c.slotWorld(this.slot[i], _v);
          this.x[i] = _v.x;
          this.y[i] = _v.y;
          this.z[i] = _v.z;
          this.heading[i] = c.yaw;
          break;
        }
        case S_ADVANCE:
          this.updateAdvance(i, dt, burstInterval, hitChance);
          break;
        case S_PRONE:
          this.anim[i] = Math.min(1, this.anim[i] + dt * 2.5);
          this.timer[i] -= dt;
          this.faceBunker(i, dt);
          this.fireTimer[i] -= dt;
          if (this.fireTimer[i] <= 0 && this.anim[i] >= 1) {
            this.fire(i, hitChance, true);
            this.fireTimer[i] = burstInterval * rng.range(0.6, 1.3);
          }
          if (this.timer[i] <= 0) {
            this.state[i] = S_ADVANCE;
            this.timer[i] = rng.range(3, 6);
          }
          break;
        case S_ASSAULT: {
          this.faceBunker(i, dt);
          this.timer[i] -= dt;
          // alternate between kneeling/standing fire and going prone
          if (this.timer[i] <= 0) {
            this.anim[i] = this.anim[i] > 0.5 ? 0 : 1;
            this.timer[i] = rng.range(4, 9);
          }
          this.fireTimer[i] -= dt;
          if (this.fireTimer[i] <= 0) {
            this.fire(i, hitChance * 1.2, this.anim[i] > 0.5);
            this.fireTimer[i] = burstInterval * rng.range(0.6, 1.2);
          }
          this.grenadeTimer[i] -= dt;
          if (this.grenadeTimer[i] <= 0) {
            this.throwGrenade(i);
            this.grenadeTimer[i] = rng.range(lerp(11, 5, p), lerp(16, 8, p));
          }
          break;
        }
        case S_CHUTE: {
          this.timer[i] += dt;
          const open = Math.min(1, this.timer[i] / 1.2);
          const fall = open < 1 ? lerp(18, 5, open) : 5;
          this.y[i] -= fall * dt;
          this.x[i] += Math.sin(this.seed[i]) * 1.4 * dt;
          this.z[i] += Math.cos(this.seed[i]) * 1.4 * dt;
          const g = Math.max(0, heightAt(this.x[i], this.z[i]));
          const c = this.chute[i];
          if (c) {
            c.root.position.set(this.x[i], this.y[i] + 1.7, this.z[i]);
            c.root.scale.setScalar(0.1 + open * 0.9);
            c.root.rotation.set(Math.sin(this.timer[i] * 1.3 + this.seed[i]) * 0.12, this.heading[i], Math.cos(this.timer[i] * 1.1) * 0.1);
          }
          if (this.y[i] <= g) {
            this.y[i] = g;
            this.releaseChute(i);
            if (heightAt(this.x[i], this.z[i]) < -1.6) {
              // landed in deep water: drowns
              this.kill(i, 'mg');
              this.state[i] = S_DEAD;
              this.timer[i] = 0;
              game.effects.splash(this.x[i], this.z[i], false);
              break;
            }
            this.state[i] = S_ADVANCE;
            this.assignTarget(i);
            this.hasWaypoint[i] = 0;
            this.timer[i] = rng.range(2, 5);
          }
          break;
        }
        case S_FALLING: {
          this.vy[i] -= 9.8 * dt;
          this.y[i] += this.vy[i] * dt;
          const c = this.chute[i];
          if (c) {
            c.root.position.y += 2 * dt;
            c.root.rotation.z += dt * 0.8;
          }
          const g = Math.max(-1.2, heightAt(this.x[i], this.z[i]));
          if (this.y[i] <= g) {
            this.y[i] = Math.max(g, heightAt(this.x[i], this.z[i]));
            this.releaseChute(i);
            this.state[i] = S_DYING;
            this.anim[i] = 0.7;
            this.timer[i] = 0;
            if (heightAt(this.x[i], this.z[i]) < 0) game.effects.splash(this.x[i], this.z[i], true);
          }
          break;
        }
        case S_DYING:
          this.timer[i] += dt;
          this.anim[i] = Math.min(1, this.anim[i] + dt * 1.8);
          if (this.anim[i] >= 1) {
            this.state[i] = S_DEAD;
            this.timer[i] = 0;
          }
          break;
        case S_DEAD:
          this.timer[i] += dt;
          if (this.timer[i] > 30) {
            this.y[i] -= dt * 0.25;
            if (this.timer[i] > 34) this.state[i] = S_FREE;
          }
          break;
      }
    }
    this.render();
  }

  updateAdvance(i, dt) {
    let tx = this.tx[i];
    let tz = this.tz[i];
    if (this.hasWaypoint[i]) {
      tx = this.wx[i];
      tz = this.wz[i];
    }
    const dx = tx - this.x[i];
    const dz = tz - this.z[i];
    const d = Math.hypot(dx, dz);
    if (d < 2) {
      if (this.hasWaypoint[i]) {
        this.hasWaypoint[i] = 0;
      } else {
        this.state[i] = S_ASSAULT;
        this.anim[i] = rng.chance(0.5) ? 1 : 0;
        this.timer[i] = rng.range(3, 8);
        this.fireTimer[i] = rng.range(0.5, 2);
        return;
      }
    }
    const h = this.y[i];
    const wading = h < -0.2;
    const zig = this.hasWaypoint[i] ? 0 : Math.sin(this.phase[i] * 0.23 + this.seed[i]) * 0.4;
    const want = Math.atan2(dx, dz) + zig;
    this.heading[i] += wrapAngle(want - this.heading[i]) * Math.min(1, dt * 5);
    const sp = this.speed[i] * (wading ? 0.45 : 1);
    this.x[i] += Math.sin(this.heading[i]) * sp * dt;
    this.z[i] += Math.cos(this.heading[i]) * sp * dt;
    this.y[i] = heightAt(this.x[i], this.z[i]);
    this.phase[i] += dt * sp * 2.3;
    this.anim[i] = Math.max(0, this.anim[i] - dt * 3);
    this.timer[i] -= dt;
    if (this.timer[i] <= 0 && !wading && !this.hasWaypoint[i] && Math.hypot(this.x[i], this.z[i]) < 160) {
      this.state[i] = S_PRONE;
      this.timer[i] = rng.range(1.8, 3.8);
      this.fireTimer[i] = rng.range(0.6, 1.4);
    }
  }

  faceBunker(i, dt) {
    const want = Math.atan2(-this.x[i], -this.z[i]);
    this.heading[i] += wrapAngle(want - this.heading[i]) * Math.min(1, dt * 4);
  }

  muzzleOf(i, prone, out) {
    const h = this.heading[i];
    const up = prone ? 0.35 : 1.4;
    const fwd = prone ? 1.2 : 0.75;
    return out.set(this.x[i] + Math.sin(h) * fwd, this.y[i] + up, this.z[i] + Math.cos(h) * fwd);
  }

  fire(i, hitChance, prone) {
    const d = Math.hypot(this.x[i], this.z[i]);
    if (d > 190) return;
    const from = this.muzzleOf(i, prone, _p);
    const rounds = rng.int(2, 4);
    this.game.enemyFire.burst(from, rounds, 0.11, {
      kind: 'rifle',
      hitChance: hitChance * clamp(1.4 - d / 200, 0.4, 1.2),
      damage: 0.1,
      color: [0.6, 3.2, 0.8],
    });
  }

  throwGrenade(i) {
    const d = Math.hypot(this.x[i], this.z[i]);
    if (d > 45) return;
    this.anim[i] = 0;
    _p.set(this.x[i], this.y[i] + 1.7, this.z[i]);
    this.game.enemyFire.grenade(_p, rng.chance(0.55));
  }

  // ------------------------------------------------------------------ rendering

  render() {
    const P = this.byName;
    const hipY = this.hipY;
    let n = 0;
    for (let i = 0; i < MAX; i++) {
      const st = this.state[i];
      if (st === S_FREE) continue;
      const x = this.x[i];
      const y = this.y[i];
      const z = this.z[i];
      const h = this.heading[i];
      const a = this.anim[i];
      // pose parameters
      let bodyPitch = 0;
      let bodyRoll = 0;
      let lift = 0;
      let back = 0;
      let lean = 0;
      let legL = 0;
      let legR = 0;
      let armL = -1.1;
      let armR = -0.9;
      let armLz = 0.25;
      let armRz = -0.2;
      let rifleX = -0.95;
      let rifleZ = 0.55;
      let riflePos = 0; // 0 = port arms, 1 = shouldered
      let proneK = 0;
      switch (st) {
        case S_CARRIED:
          legL = legR = -0.1;
          lean = 0.12 + Math.sin(this.seed[i] + this.game.time) * 0.03;
          break;
        case S_ADVANCE: {
          const s = Math.sin(this.phase[i]);
          legL = s * 0.8;
          legR = -s * 0.8;
          lean = 0.22;
          armL = -1.15 - s * 0.12;
          armR = -0.85 + s * 0.12;
          lift = Math.abs(Math.cos(this.phase[i])) * 0.06;
          proneK = a;
          break;
        }
        case S_PRONE:
          proneK = a;
          break;
        case S_ASSAULT:
          proneK = a;
          riflePos = 1;
          break;
        case S_CHUTE:
        case S_FALLING:
          armL = armR = -2.9;
          armLz = 0.25;
          armRz = -0.25;
          legL = Math.sin(this.game.time * 2 + this.seed[i]) * 0.15;
          legR = -legL;
          rifleX = -0.3;
          break;
        case S_DYING:
        case S_DEAD: {
          const k = st === S_DEAD ? 1 : a;
          const e = k * k;
          const fwd = Math.cos(this.deathDir[i]) > 0 ? 1 : -1; // fall away from the shooter
          bodyPitch = fwd * e * HALF_PI;
          bodyRoll = Math.sin(this.seed[i]) * 0.3 * e;
          lift = e * 0.18;
          armL = -0.6 - e * 1.6;
          armR = -0.4 + e * 0.8;
          legL = e * 0.25;
          legR = -e * 0.1;
          break;
        }
      }
      if (proneK > 0 && st !== S_DYING && st !== S_DEAD) {
        const k = proneK * proneK * (3 - 2 * proneK);
        bodyPitch = k * HALF_PI;
        back = -0.9 * k;
        lift = lerp(lift, 0.18, k);
        lean = lerp(lean, 0, k);
        legL = lerp(legL, 0.05, k);
        legR = lerp(legR, -0.05, k);
        armL = lerp(armL, -2.75, k);
        armR = lerp(armR, -2.6, k);
        riflePos = k > 0.5 ? 2 : riflePos;
      }
      if (riflePos === 1) {
        armL = -1.45;
        armR = -1.25;
        armLz = 0.45;
        armRz = -0.1;
      }

      // soldier base matrix
      _e.set(0, h, 0, 'YXZ');
      _q.setFromEuler(_e);
      _p.set(x, y + lift, z);
      _base.compose(_p, _q, _s);
      if (back !== 0) _base.multiply(_tmp.makeTranslation(0, 0, back));
      if (bodyPitch !== 0 || bodyRoll !== 0) _base.multiply(rot(bodyPitch, 0, bodyRoll));

      // torso
      const tp = P.torso.pivot;
      _torso.copy(_base).multiply(_tmp.makeTranslation(tp.x, tp.y, tp.z)).multiply(rot(lean, 0, 0));
      this.setPart(P.torso, n, _torso);
      for (const name of ['head', 'helmet']) {
        const part = P[name];
        if (!part) continue;
        _m.copy(_torso).multiply(_tmp.makeTranslation(part.pivot.x - tp.x, part.pivot.y - tp.y, part.pivot.z - tp.z));
        this.setPart(part, n, _m);
      }
      this.limb(P.armL, n, _torso, tp, armL, armLz);
      this.limb(P.armR, n, _torso, tp, armR, armRz);
      this.limb(P.legL, n, _base, null, legL, 0.03);
      this.limb(P.legR, n, _base, null, legR, -0.03);
      if (P.rifle) {
        const rp = P.rifle.pivot;
        if (riflePos === 0) {
          _m.copy(_torso).multiply(_tmp.makeTranslation(0.05, 0.3, 0.3)).multiply(rot(rifleX, 0, rifleZ));
        } else if (riflePos === 1) {
          _m.copy(_torso).multiply(_tmp.makeTranslation(-0.12, 0.5, 0.35)).multiply(rot(0.05, 0, 0));
        } else {
          _m.copy(_torso).multiply(_tmp.makeTranslation(-0.1, 0.9, 0.1)).multiply(rot(-HALF_PI, 0, 0));
        }
        this.setPart(P.rifle, n, _m);
        void rp;
      }
      n++;
    }
    for (const p of this.parts) {
      p.mesh.count = n;
      if (n) p.mesh.instanceMatrix.needsUpdate = true;
    }
    void hipY;
  }

  limb(part, n, parent, parentPivot, rx, rz) {
    if (!part) return;
    const pv = part.pivot;
    if (parentPivot) {
      _m.copy(parent).multiply(_tmp.makeTranslation(pv.x - parentPivot.x, pv.y - parentPivot.y, pv.z - parentPivot.z));
    } else {
      _m.copy(parent).multiply(_tmp.makeTranslation(pv.x, pv.y, pv.z));
    }
    _m.multiply(rot(rx, 0, rz));
    this.setPart(part, n, _m);
  }

  setPart(part, n, m) {
    part.mesh.setMatrixAt(n, m);
  }
}
