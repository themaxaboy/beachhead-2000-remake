import * as THREE from 'three';
import { Entity } from './Entity.js';
import { buildF4, buildB52, buildCargoPlane, applyCharred } from './models/index.js';
import { heightAt } from '../world/Terrain.js';
import { aggressionLerp as ag } from '../config.js';
import { rng } from '../core/rng.js';
import { wrapAngle, clamp, lerp } from '../core/math.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const G = 9.81;

/** Fixed-wing flight model: heading + bank + climb toward a target altitude. */
export class Aircraft extends Entity {
  constructor(game, type) {
    super(game, type);
    this.isAir = true;
    this.radarKind = 'air';
    this.speed = 150;
    this.targetAlt = 300;
    this.turnRate = 0.5;
    this.climbRate = 40;
    this.bank = 0;
    this.trailAcc = 0;
  }

  steerTo(tx, tz, dt, rate = this.turnRate) {
    const want = Math.atan2(tx - this.pos.x, tz - this.pos.z);
    const err = wrapAngle(want - this.yaw);
    const turn = clamp(err * 1.5, -rate, rate);
    this.yaw += turn * dt;
    this.bank += (clamp(-turn * 1.6, -1.2, 1.2) - this.bank) * Math.min(1, dt * 3);
    return err;
  }

  fly(dt) {
    const dy = clamp(this.targetAlt - this.pos.y, -this.climbRate, this.climbRate);
    const vy = dy * 0.8;
    this.vel.set(Math.sin(this.yaw) * this.speed, vy, Math.cos(this.yaw) * this.speed);
    this.pos.addScaledVector(this.vel, dt);
    this.pitch += (-Math.atan2(vy, this.speed) - this.pitch) * Math.min(1, dt * 2);
    this.roll = this.bank;
  }

  /** Shot-down behaviour: tumble with a burning trail and explode on impact. */
  updateFalling(dt, trailOffset) {
    this.deadTime += dt;
    this.vel.y -= G * dt * 1.2;
    this.vel.multiplyScalar(1 - 0.12 * dt);
    this.pos.addScaledVector(this.vel, dt);
    this.roll += dt * this.spinRate;
    this.pitch = Math.max(-1.2, this.pitch - dt * 0.35);
    this.trailAcc += dt * 25;
    while (this.trailAcc > 1) {
      this.trailAcc -= 1;
      _v.copy(trailOffset).applyMatrix4(this.root.matrixWorld);
      this.game.effects.trail(_v.x, _v.y, _v.z, 'burning');
    }
    const ground = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y <= Math.max(0, ground) + 1) {
      const fx = this.game.effects;
      if (ground < 0) {
        fx.explosion(this.pos.x, 0.5, this.pos.z, 'L', { water: true });
      } else {
        fx.explosion(this.pos.x, ground + 1, this.pos.z, 'L');
        fx.addFire(new THREE.Vector3(this.pos.x, ground, this.pos.z), new THREE.Vector3(), { duration: 25, size: 1.4 });
      }
      this.remove();
    }
  }

  startFalling() {
    this.spinRate = rng.range(1.5, 3) * rng.sign();
    this.vel.y = Math.min(this.vel.y, 0) - 5;
    this.solid = true;
    this.game.effects.explosion(this.pos.x, this.pos.y, this.pos.z, 'M', { air: true });
    applyCharred(this.root, this.game.mats);
  }
}

// -------------------------------------------------------------------------- F-4

/** F-4 Phantom: strafing and bombing runs over the bunker from changing directions. */
export class Jet extends Aircraft {
  constructor(game, { bearing }) {
    super(game, 'jet');
    this.model = buildF4(game.mats);
    this.root.add(this.model.root);
    this.addSphere(0, 0, 3.5, 1.6);
    this.addSphere(0, 0, -1.5, 1.8);
    this.addSphere(3.2, 0, -1.2, 1.5);
    this.addSphere(-3.2, 0, -1.2, 1.5);
    this.addSphere(0, 0, -6.5, 1.4);
    const a = this.aggression.jet;
    // Kept low, slow-ish and close to the bunker so the jet is a fair target.
    this.runSpeed = ag(a, 125, 175);
    this.runAlt = ag(a, 70, 32);
    this.speed = this.runSpeed;
    this.approach = bearing;
    const r = 2000;
    this.pos.set(Math.sin(bearing) * r, 200, -Math.cos(bearing) * r);
    this.yaw = Math.atan2(-this.pos.x, -this.pos.z);
    this.targetAlt = 200;
    this.startRun();
    this.gunTimer = 0;
    this.startLoop('jetLoop', 1);
    this.sync();
  }

  startRun() {
    this.setState('run');
    this.offset = rng.range(-18, 18);
    this.bombsLeft = this.game.level.progress >= 0.4 ? 4 : 2;
    this.bombTimer = 0;
    const a = this.aggression.jet;
    const miss = ag(a, 45, 8);
    const h = this.runAlt;
    this.releaseDist = this.runSpeed * Math.sqrt((2 * h) / G) + rng.range(-miss, miss);
    this.strafed = 0;
  }

  update(dt) {
    super.update(dt);
    if (!this.alive) {
      if (!this.removed) this.updateFalling(dt, _w.set(0, 0, -7));
      return;
    }
    const a = this.aggression.jet;
    // afterburner / heat haze trail
    const bx = -Math.cos(this.yaw) * this.offset;
    const bz = Math.sin(this.yaw) * this.offset;
    switch (this.state) {
      case 'run': {
        const tx = bx;
        const tz = bz;
        // along-track distance to the bunker
        const fwdX = Math.sin(this.yaw);
        const fwdZ = Math.cos(this.yaw);
        const along = -(this.pos.x * fwdX + this.pos.z * fwdZ);
        if (along > 350) this.steerTo(tx, tz, dt, 0.6);
        else this.bank *= 1 - Math.min(1, dt * 2);
        const d = Math.hypot(this.pos.x - tx, this.pos.z - tz);
        this.targetAlt = d < 1500 ? this.runAlt : 200;
        this.speed = this.runSpeed;
        if (along < 1150 && along > 380 && Math.abs(this.pos.y - this.runAlt) < 40) {
          this.gunTimer -= dt;
          if (this.gunTimer <= 0) {
            this.gunTimer = 0.75;
            this.model.gunMuzzle.getWorldPosition(_v);
            this.game.enemyFire.burst(_v.clone(), 6, 0.05, {
              kind: 'jetgun',
              hitChance: ag(a, 0.05, 0.25),
              damage: 0.3,
              color: [5, 2.5, 0.8],
              width: 0.14,
              speed: 900,
              len: 12,
            });
          }
        }
        if (this.bombsLeft > 0 && along < this.releaseDist && along > -50) {
          this.bombTimer -= dt;
          if (this.bombTimer <= 0) {
            this.bombTimer = 0.12;
            this.bombsLeft--;
            this.model.bombs.visible = this.bombsLeft > 0;
            _v.copy(this.pos);
            _v.y -= 1.2;
            _w.copy(this.vel).multiplyScalar(0.97);
            _w.x += rng.range(-3, 3);
            _w.z += rng.range(-3, 3);
            this.game.enemyFire.bomb(_v, _w, { whistle: true });
          }
        }
        if (along < -300) {
          this.setState('egress');
        }
        break;
      }
      case 'egress':
        this.targetAlt = 200;
        this.bank *= 0.95;
        this.roll = this.bank;
        if (this.stateTime > 4.5) {
          // pick a new attack direction
          const cur = Math.atan2(this.pos.x, -this.pos.z);
          const anywhere = this.game.level.def.number >= 20;
          let b = cur + rng.sign() * rng.range(0.6, 2.4);
          if (!anywhere) b = clamp(wrapAngle(b), -1.35, 1.35);
          this.entry = { x: Math.sin(b) * 1600, z: -Math.cos(b) * 1600 };
          this.setState('turn');
          this.model.bombs.visible = true;
        }
        break;
      case 'turn': {
        this.targetAlt = 180;
        this.steerTo(this.entry.x, this.entry.z, dt, 0.5);
        const d = Math.hypot(this.pos.x - this.entry.x, this.pos.z - this.entry.z);
        if (d < 450 || this.stateTime > 40) this.startRun();
        break;
      }
    }
    this.fly(dt);
    if (this.state === 'egress') this.bank *= 1 - dt;
    this.smoke(dt, _w.set(0, 0, -7));
  }

  onDestroyed() {
    this.startFalling();
    if (this.loop) this.loop.setVolume(0.5);
  }
}

// -------------------------------------------------------------------------- B-52

/** B-52 carpet bomber: flies straight over the beach. Optional target. */
export class Bomber extends Aircraft {
  constructor(game, { bearing, lateral, trail }) {
    super(game, 'bomber');
    this.required = false;
    this.radarKind = 'bomber';
    this.model = buildB52(game.mats);
    this.root.add(this.model.root);
    for (const z of [-18, -8, 2, 12, 20]) this.addSphere(0, 0, z, 2.6);
    for (const x of [-20, -11, 11, 20]) this.addSphere(x, 0.5, 0, 3.2);
    this.speed = 95;
    this.targetAlt = 260;
    const dirX = -Math.sin(bearing);
    const dirZ = Math.cos(bearing);
    const start = 3800 + trail;
    // path through (lateral offset) the bunker
    this.pos.set(Math.sin(bearing) * start - dirZ * lateral, this.targetAlt, -Math.cos(bearing) * start + dirX * lateral);
    this.yaw = Math.atan2(dirX, dirZ);
    this.lead = this.speed * Math.sqrt((2 * this.targetAlt) / G);
    this.bombTimer = 0;
    this.bombs = 30;
    this.startLoop('b52Loop', 1);
    this.sync();
  }

  update(dt) {
    super.update(dt);
    if (!this.alive) {
      if (!this.removed) this.updateFalling(dt, _w.set(0, 0, -15));
      return;
    }
    this.fly(dt);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const along = -(this.pos.x * fx + this.pos.z * fz); // distance still to go to the bunker
    if (this.bombs > 0 && along < this.lead + 320 && along > this.lead - 320) {
      this.bombTimer -= dt;
      if (this.bombTimer <= 0) {
        this.bombTimer = 0.2;
        this.bombs--;
        this.model.bombBay.getWorldPosition(_v);
        this.game.enemyFire.bomb(_v, _w.copy(this.vel), { big: true, whistle: this.bombs % 4 === 0 });
      }
    }
    if (along < -3800) this.withdraw();
    this.smoke(dt, _w.set(0, 0, -10));
  }

  onDestroyed() {
    this.startFalling();
    this.spinRate *= 0.3;
  }
}

// -------------------------------------------------------------------------- supply plane

/** Friendly C-130 that drops parachuted supply crates over the beach. Cannot be damaged. */
export class SupplyPlane extends Aircraft {
  constructor(game, { bearing, crates }) {
    super(game, 'supply');
    this.required = false;
    this.lockable = false;
    this.radarKind = 'friendly';
    this.model = buildCargoPlane(game.mats);
    this.root.add(this.model.root);
    for (const z of [-10, 0, 10]) this.addSphere(0, 0, z, 2.6);
    this.addSphere(-12, 2, 0, 3);
    this.addSphere(12, 2, 0, 3);
    this.speed = 75;
    this.targetAlt = 180;
    const lateral = rng.range(-60, 60);
    const dirX = -Math.sin(bearing);
    const dirZ = Math.cos(bearing);
    this.pos.set(Math.sin(bearing) * 2500 - dirZ * lateral, 180, -Math.cos(bearing) * 2500 + dirX * lateral);
    this.yaw = Math.atan2(dirX, dirZ);
    this.crates = crates; // array of kinds
    this.dropAt = rng.range(80, 150);
    this.dropTimer = 0;
    this.startLoop('propLoop', 1);
    this.sync();
  }

  hit(cls, point) {
    if (point) this.game.effects.metalHit(point.x, point.y, point.z);
    return 0;
  }

  update(dt) {
    super.update(dt);
    this.fly(dt);
    for (const p of this.model.props) p.rotation.z += dt * 40;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const along = -(this.pos.x * fx + this.pos.z * fz);
    // open the cargo ramp for the air drop
    const wantRamp = along < 900 && this.crates.length ? 1 : 0;
    this.rampT = (this.rampT || 0) + Math.sign(wantRamp - (this.rampT || 0)) * dt * 0.3;
    this.rampT = Math.min(1, Math.max(0, this.rampT));
    this.model.setRampOpen(this.rampT);
    if (this.crates.length && along < -this.dropAt) {
      this.dropTimer -= dt;
      if (this.dropTimer <= 0) {
        this.dropTimer = 0.9;
        const kind = this.crates.shift();
        this.model.dropPoint.getWorldPosition(_v);
        this.game.spawnCrate(kind, _v, _w.copy(this.vel).multiplyScalar(0.35));
      }
    }
    if (along < -2600) this.withdraw();
  }
}

export { lerp };
