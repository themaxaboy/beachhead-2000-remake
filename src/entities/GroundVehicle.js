import * as THREE from 'three';
import { Entity } from './Entity.js';
import { heightAt } from '../world/Terrain.js';
import { wrapAngle, clamp, bearingOf } from '../core/math.js';
import { rng } from '../core/rng.js';
import { applyCharred } from './models/index.js';

const _v = new THREE.Vector3();

/** Shared driving / terrain-following behaviour for tanks and APCs. */
export class GroundVehicle extends Entity {
  constructor(game, type, carrier) {
    super(game, type);
    this.carrier = carrier || null;
    this.speed = 0;
    this.maxSpeed = 5;
    this.turnRate = 0.45;
    this.length = 6.5;
    this.targetX = 0;
    this.targetZ = 0;
    this.dustAcc = 0;
    if (carrier) this.setState('cargo');
  }

  /** Picks a stopping point `dist` metres from the bunker, roughly on the vehicle's current bearing. */
  pickPosition(dist, spread = 0.25) {
    let b = bearingOf(this.pos.x, this.pos.z) + rng.range(-spread, spread);
    b = clamp(b, -1.3, 1.3);
    this.targetX = Math.sin(b) * dist;
    this.targetZ = -Math.cos(b) * dist;
  }

  followCarrier() {
    const c = this.carrier;
    if (!c || c.removed) return;
    c.slotWorld(-1, _v);
    this.pos.copy(_v);
    this.yaw = c.yaw;
    this.pitch = c.pitch;
    this.roll = c.roll;
  }

  /** Drives toward (targetX, targetZ). Returns remaining distance. */
  drive(dt, arriveDist = 3) {
    const dx = this.targetX - this.pos.x;
    const dz = this.targetZ - this.pos.z;
    const d = Math.hypot(dx, dz);
    let want = Math.atan2(dx, dz);
    // steer around obstacles and wrecks
    let ax = 0;
    let az = 0;
    const look = 14;
    const fx = this.pos.x + Math.sin(this.yaw) * look * 0.5;
    const fz = this.pos.z + Math.cos(this.yaw) * look * 0.5;
    const avoid = (ox, oz, r) => {
      const ex = fx - ox;
      const ez = fz - oz;
      const e = Math.hypot(ex, ez);
      const rr = r + 4;
      if (e < rr && e > 0.01) {
        ax += (ex / e) * (rr - e);
        az += (ez / e) * (rr - e);
      }
    };
    for (const o of this.game.world.obstacles) avoid(o.x, o.z, o.r);
    for (const e of this.game.entities.list) {
      if (e === this || e.isAir || e.type === 'lct' || e.state === 'cargo') continue;
      avoid(e.pos.x, e.pos.z, 3);
    }
    if (ax || az) {
      want = Math.atan2(dx / Math.max(d, 1) + ax * 0.25, dz / Math.max(d, 1) + az * 0.25);
    }
    const err = wrapAngle(want - this.yaw);
    this.yaw += clamp(err, -this.turnRate * dt, this.turnRate * dt);
    const targetSpeed = d < arriveDist ? 0 : Math.min(this.maxSpeed, d * 0.6) * (Math.abs(err) > 1 ? 0.35 : 1);
    this.speed += clamp(targetSpeed - this.speed, -4 * dt, 2 * dt);
    this.move(dt);
    return d;
  }

  move(dt) {
    const s = this.speed;
    this.vel.set(Math.sin(this.yaw) * s, 0, Math.cos(this.yaw) * s);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.alignToGround(dt);
    if (Math.abs(s) > 0.5 && heightAt(this.pos.x, this.pos.z) > 0.2) {
      this.dustAcc += dt * Math.abs(s) * 1.2;
      while (this.dustAcc > 1) {
        this.dustAcc -= 1;
        const bx = this.pos.x - Math.sin(this.yaw) * this.length * 0.5 + rng.range(-1.4, 1.4);
        const bz = this.pos.z - Math.cos(this.yaw) * this.length * 0.5;
        this.game.effects.trail(bx, heightAt(bx, bz) + 0.4, bz, 'dust');
      }
    }
  }

  alignToGround(dt) {
    const L = this.length * 0.45;
    const W = 1.5;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const hf = Math.max(-2, heightAt(this.pos.x + sy * L, this.pos.z + cy * L));
    const hb = Math.max(-2, heightAt(this.pos.x - sy * L, this.pos.z - cy * L));
    const hl = Math.max(-2, heightAt(this.pos.x + cy * W, this.pos.z - sy * W));
    const hr = Math.max(-2, heightAt(this.pos.x - cy * W, this.pos.z + sy * W));
    const targetY = (hf + hb + hl + hr) / 4;
    this.pos.y += (targetY - this.pos.y) * Math.min(1, dt * 10);
    const wantPitch = -Math.atan2(hf - hb, L * 2);
    const wantRoll = Math.atan2(hl - hr, W * 2);
    this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * 6);
    this.roll += (wantRoll - this.roll) * Math.min(1, dt * 6);
  }

  faceAngleTo(x, z) {
    return wrapAngle(Math.atan2(x - this.pos.x, z - this.pos.z) - this.yaw);
  }

  /** Destroyed while still inside its landing craft. */
  sinkWithCarrier(cause) {
    this.destroy(cause);
    this.root.visible = false;
    this.solid = false;
    this.remove();
  }

  wreck(scale = 1) {
    applyCharred(this.root, this.game.mats);
    this.speed = 0;
    this.vel.set(0, 0, 0);
    this.fire = this.game.effects.addFire(this.root, new THREE.Vector3(0, 2, 0), { duration: 45, size: 1.2 * scale });
    this.game.world.obstacles.push({ x: this.pos.x, z: this.pos.z, r: 3, wreck: true });
    if (this.loop) {
      this.loop.stop(0.5);
      this.loop = null;
    }
  }
}
