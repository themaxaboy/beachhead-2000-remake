import * as THREE from 'three';
import { Aircraft } from './Aircraft.js';
import { buildCobra, buildCH53 } from './models/index.js';
import { heightAt } from '../world/Terrain.js';
import { aggressionLerp as ag } from '../config.js';
import { rng } from '../core/rng.js';
import { wrapAngle, clamp, lerp } from '../core/math.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const BUNKER_AIM = new THREE.Vector3(0, 5, 0);

/** Shared helicopter movement: velocity steering toward a point, nose, bank and rotor animation. */
class Helicopter extends Aircraft {
  constructor(game, type) {
    super(game, type);
    this.maxSpeed = 50;
    this.accel = 12;
    this.rotorSpeed = 1;
    this.faceTarget = null; // point to keep the nose on (attack), otherwise face travel direction
  }

  moveTo(tx, ty, tz, dt, speedLimit = this.maxSpeed, arrive = 60) {
    _v.set(tx - this.pos.x, ty - this.pos.y, tz - this.pos.z);
    const d = _v.length();
    const want = d > 0.01 ? Math.min(speedLimit, (d / arrive) * speedLimit) : 0;
    if (d > 0.01) _v.multiplyScalar(want / d);
    _w.subVectors(_v, this.vel);
    const maxDv = this.accel * dt;
    if (_w.length() > maxDv) _w.setLength(maxDv);
    this.vel.add(_w);
    this.pos.addScaledVector(this.vel, dt);
    const ground = Math.max(0, heightAt(this.pos.x, this.pos.z));
    if (this.pos.y < ground + 12) this.pos.y = ground + 12;
    return d;
  }

  orient(dt) {
    let wantYaw;
    if (this.faceTarget) wantYaw = Math.atan2(this.faceTarget.x - this.pos.x, this.faceTarget.z - this.pos.z);
    else if (Math.hypot(this.vel.x, this.vel.z) > 3) wantYaw = Math.atan2(this.vel.x, this.vel.z);
    else wantYaw = this.yaw;
    this.yaw += clamp(wrapAngle(wantYaw - this.yaw), -1.2 * dt, 1.2 * dt);
    // pitch / bank from velocity in the body frame
    const fwd = this.vel.x * Math.sin(this.yaw) + this.vel.z * Math.cos(this.yaw);
    const side = this.vel.x * Math.cos(this.yaw) - this.vel.z * Math.sin(this.yaw);
    this.pitch += (clamp(fwd * 0.006, -0.3, 0.3) - this.pitch) * Math.min(1, dt * 3);
    this.roll += (clamp(side * 0.012, -0.5, 0.5) - this.roll) * Math.min(1, dt * 3);
  }

  spinRotors(dt) {
    const m = this.model;
    m.mainRotor.rotation.y += dt * 28 * this.rotorSpeed;
    m.tailRotor.rotation.x += dt * 60 * this.rotorSpeed;
    if (m.mainRotorBlur) {
      const fast = this.rotorSpeed > 0.5;
      m.mainRotorBlur.visible = fast;
      m.mainRotorBlur.rotation.y = m.mainRotor.rotation.y;
    }
  }

  onDestroyed() {
    this.spinRate = rng.range(2, 3.5) * rng.sign();
    this.game.effects.explosion(this.pos.x, this.pos.y, this.pos.z, 'M', { air: true });
    if (this.loop) this.loop.setVolume(0.6);
  }

  /** Helicopters spin down around the mast and fall. */
  updateHeliFalling(dt) {
    this.deadTime += dt;
    this.vel.y -= 9.81 * dt;
    this.vel.x *= 1 - dt * 0.4;
    this.vel.z *= 1 - dt * 0.4;
    this.pos.addScaledVector(this.vel, dt);
    this.yaw += this.spinRate * dt;
    this.roll = Math.sin(this.deadTime * 3) * 0.3;
    this.pitch = Math.min(0.6, this.pitch + dt * 0.2);
    this.rotorSpeed = Math.max(0.2, this.rotorSpeed - dt * 0.4);
    this.spinRotors(dt);
    this.trailAcc += dt * 25;
    while (this.trailAcc > 1) {
      this.trailAcc -= 1;
      this.game.effects.trail(this.pos.x, this.pos.y + 1, this.pos.z, 'burning');
    }
    const ground = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y <= Math.max(0, ground) + 1) {
      const fx = this.game.effects;
      fx.explosion(this.pos.x, Math.max(0, ground) + 1, this.pos.z, 'L', { water: ground < 0 });
      if (ground > 0) fx.addFire(new THREE.Vector3(this.pos.x, ground, this.pos.z), new THREE.Vector3(), { duration: 30, size: 1.3 });
      this.remove();
    }
  }
}

// -------------------------------------------------------------------------- AH-1 Cobra

export class Cobra extends Helicopter {
  constructor(game, { bearing }) {
    super(game, 'cobra');
    this.model = buildCobra(game.mats);
    this.root.add(this.model.root);
    this.addSphere(0, 0.3, 2.5, 1.4);
    this.addSphere(0, 0.3, -0.5, 1.5);
    this.addSphere(0, 0.8, -4.5, 1.0);
    const a = this.aggression;
    this.ring = ag(a.heliGun, 470, 260);
    this.bearing = bearing;
    const r = 2200;
    this.pos.set(Math.sin(bearing) * r, 60, -Math.cos(bearing) * r);
    this.yaw = Math.atan2(-this.pos.x, -this.pos.z);
    this.gunTimer = ag(a.heliGun, 8, 2.5) * rng.range(0.4, 0.8);
    this.rocketTimer = ag(a.heliRocket, 16, 5) * rng.range(0.5, 1);
    this.relocateTimer = ag(a.heliGun, 30, 12);
    this.burst = 0;
    this.burstTimer = 0;
    this.rocketsLeft = 0;
    this.rocketSide = 0;
    this.jink = rng.range(0, 10);
    this.alt = rng.range(25, 45);
    this.maxSpeed = 55;
    this.setState('ingress');
    this.startLoop('cobraLoop', 1);
    this.sync();
  }

  attackPoint(out) {
    return out.set(Math.sin(this.bearing) * this.ring, this.alt, -Math.cos(this.bearing) * this.ring);
  }

  update(dt) {
    super.update(dt);
    if (!this.alive) {
      if (!this.removed) this.updateHeliFalling(dt);
      return;
    }
    const a = this.aggression;
    const tgt = this.attackPoint(new THREE.Vector3());
    switch (this.state) {
      case 'ingress':
        this.faceTarget = null;
        if (this.moveTo(tgt.x, tgt.y, tgt.z, dt, 55, 120) < 40) this.setState('attack');
        break;
      case 'attack': {
        this.faceTarget = BUNKER_AIM;
        this.jink += dt;
        const js = ag(a.heliGun, 6, 18);
        const side = Math.sin(this.jink * 0.7) * js;
        this.bearing += (side / this.ring) * dt * 0.5;
        this.alt = 32 + Math.sin(this.jink * 0.45) * 12;
        this.attackPoint(tgt);
        tgt.x += Math.cos(this.bearing) * side * 0.6;
        tgt.z += Math.sin(this.bearing) * side * 0.6;
        this.moveTo(tgt.x, tgt.y, tgt.z, dt, 30, 40);
        this.weapons(dt, a);
        this.relocateTimer -= dt;
        if (this.relocateTimer <= 0) {
          let nb = this.bearing + rng.sign() * rng.range(1.0, 2.6);
          if (this.game.level.def.number < 15) nb = clamp(wrapAngle(nb), -1.45, 1.45);
          this.newBearing = wrapAngle(nb);
          this.setState('relocate');
        }
        break;
      }
      case 'relocate': {
        this.faceTarget = null;
        const diff = wrapAngle(this.newBearing - this.bearing);
        const step = (45 / this.ring) * dt;
        this.bearing += clamp(diff, -step, step);
        this.alt = 50;
        this.attackPoint(tgt);
        this.moveTo(tgt.x, tgt.y, tgt.z, dt, 50, 30);
        if (Math.abs(diff) < 0.02) {
          this.relocateTimer = ag(a.heliGun, 30, 12) * rng.range(0.8, 1.3);
          this.setState('attack');
        }
        break;
      }
    }
    this.orient(dt);
    this.spinRotors(dt);
    this.smoke(dt, _w.set(0, 1, -1));
  }

  weapons(dt, a) {
    const facing = Math.abs(wrapAngle(Math.atan2(-this.pos.x, -this.pos.z) - this.yaw)) < 0.25;
    this.gunTimer -= dt;
    if (this.gunTimer <= 0 && facing) {
      this.burst = rng.range(1.2, 2);
      this.gunTimer = ag(a.heliGun, 8, 2.5) * rng.range(0.8, 1.2) + this.burst;
    }
    if (this.burst > 0) {
      this.burst -= dt;
      this.burstTimer -= dt;
      if (this.burstTimer <= 0) {
        this.burstTimer = 0.1;
        this.model.muzzle.getWorldPosition(_v);
        this.game.enemyFire.burst(_v.clone(), 1, 0, {
          kind: 'heli',
          hitChance: ag(a.heliGun, 0.1, 0.45),
          damage: 0.35,
          color: [5, 2.4, 0.7],
          width: 0.12,
          speed: 800,
          len: 9,
        });
      }
    }
    this.rocketTimer -= dt;
    if (this.rocketTimer <= 0 && facing) {
      this.rocketsLeft = 2 + Math.round(2 * this.game.level.progress);
      this.rocketTimer = ag(a.heliRocket, 16, 5) * rng.range(0.8, 1.2);
      this.rocketGap = 0;
    }
    if (this.rocketsLeft > 0) {
      this.rocketGap -= dt;
      if (this.rocketGap <= 0) {
        this.rocketGap = 0.28;
        this.rocketsLeft--;
        this.rocketSide ^= 1;
        (this.rocketSide ? this.model.rocketL : this.model.rocketR).getWorldPosition(_v);
        this.game.enemyFire.rocket(_v, rng.chance(ag(a.heliRocket, 0.35, 0.8)), 2.5);
        this.game.effects.muzzle(_v.x, _v.y, _v.z, 1.8);
      }
    }
  }
}

// -------------------------------------------------------------------------- CH-53

export class CH53 extends Helicopter {
  constructor(game, { bearing }) {
    super(game, 'ch53');
    this.model = buildCH53(game.mats);
    this.root.add(this.model.root);
    for (const z of [-6, -1, 4]) this.addSphere(0, 0.5, z, 2.3);
    this.addSphere(0, 1.5, -10, 1.2);
    const r = 2300;
    this.pos.set(Math.sin(bearing) * r, 110, -Math.cos(bearing) * r);
    this.yaw = Math.atan2(-this.pos.x, -this.pos.z);
    const db = clamp(bearing + rng.range(-0.35, 0.35), -1.0, 1.0);
    const dd = rng.range(70, 115);
    this.drop = new THREE.Vector3(Math.sin(db) * dd, 95, -Math.cos(db) * dd);
    this.troops = game.level.def.units.paratroopersPerCH53;
    this.dropTimer = 0;
    this.gunTimer = rng.range(2, 5);
    this.maxSpeed = 48;
    this.accel = 8;
    this.setState('ingress');
    this.startLoop('ch53Loop', 1);
    this.sync();
  }

  update(dt) {
    super.update(dt);
    if (!this.alive) {
      if (!this.removed) this.updateHeliFalling(dt);
      return;
    }
    switch (this.state) {
      case 'ingress': {
        const d = this.moveTo(this.drop.x, this.drop.y, this.drop.z, dt, 48, 260);
        if (d < 25) this.setState('drop');
        if (d < 400) {
          this.hatch = Math.min(1, (this.hatch || 0) + dt * 0.4);
          this.model.setRampOpen(this.hatch);
          this.model.setDoorOpen(this.hatch);
        }
        break;
      }
      case 'drop': {
        // creep forward over the beach while the troops jump
        const fx = Math.sin(this.yaw) * 10;
        const fz = Math.cos(this.yaw) * 10;
        this.moveTo(this.drop.x + fx, this.drop.y, this.drop.z + fz, dt, 8, 20);
        this.dropTimer -= dt;
        if (this.dropTimer <= 0 && this.troops > 0) {
          this.dropTimer = 0.9;
          this.troops--;
          _v.set(rng.range(-0.6, 0.6), -2.2, -9).applyMatrix4(this.root.matrixWorld);
          this.game.infantry.spawnParatrooper(_v.x, _v.y, _v.z);
        }
        if (this.troops <= 0 && this.dropTimer <= 0) {
          this.required = false;
          this.game.level.unitRemoved(this);
          const away = Math.atan2(this.pos.x, -this.pos.z);
          this.exit = new THREE.Vector3(Math.sin(away) * 2500, 160, -Math.cos(away) * 2500);
          this.setState('leave');
        }
        break;
      }
      case 'leave':
        this.hatch = Math.max(0, (this.hatch || 0) - dt * 0.3);
        this.model.setRampOpen(this.hatch);
        this.moveTo(this.exit.x, this.exit.y, this.exit.z, dt, 55, 50);
        if (Math.hypot(this.pos.x, this.pos.z) > 1900) this.withdraw();
        break;
    }
    // door gunner
    const d = Math.hypot(this.pos.x, this.pos.z);
    this.gunTimer -= dt;
    if (d < 520 && this.gunTimer <= 0) {
      this.gunTimer = rng.range(3, 6);
      this.model.doorGunMuzzle.getWorldPosition(_v);
      const a = Math.max(1, this.aggression.heliGun - 3);
      this.game.enemyFire.burst(_v.clone(), 6, 0.1, { kind: 'heli', hitChance: ag(a, 0.05, 0.3), damage: 0.15, color: [4, 2, 0.6], width: 0.1 });
    }
    this.faceTarget = null;
    this.orient(dt);
    this.spinRotors(dt);
    this.smoke(dt, _w.set(0, 2, -2));
  }

  onDestroyed(cause) {
    super.onDestroyed(cause);
    for (let i = 0; i < this.troops; i++) this.game.onCargoKill('infantry', cause, this.pos);
    this.troops = 0;
  }
}

export { lerp };
