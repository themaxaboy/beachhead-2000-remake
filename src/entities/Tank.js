import * as THREE from 'three';
import { GroundVehicle } from './GroundVehicle.js';
import { buildTank } from './models/index.js';
import { heightAt } from '../world/Terrain.js';
import { aggressionLerp as ag } from '../config.js';
import { rng } from '../core/rng.js';
import { wrapAngle, clamp } from '../core/math.js';

const _v = new THREE.Vector3();

/** M48 main battle tank: drives up the beach, stops at stand-off range and shells the bunker. */
export class Tank extends GroundVehicle {
  constructor(game, carrier) {
    super(game, 'tank', carrier);
    this.model = buildTank(game.mats);
    this.root.add(this.model.root);
    this.addSphere(0, 1.1, 2.1, 2.0);
    this.addSphere(0, 1.1, -2.1, 2.0);
    this.addSphere(0, 1.2, 0, 2.1);
    this.addSphere(0, 2.4, 0.2, 1.5);
    this.length = 6.9;
    this.maxSpeed = 5;
    this.turretYaw = 0;
    this.gunElev = 0;
    this.fireTimer = rng.range(2, 4);
    this.recoil = 0;
    this.baseGunZ = this.model.gun.position.z;
  }

  disembark() {
    this.setState('disembark');
    this.startLoop('tankLoop', 0.9);
  }

  update(dt) {
    super.update(dt);
    const a = this.aggression.tank;
    if (!this.alive) {
      this.updateWreck(dt);
      return;
    }
    switch (this.state) {
      case 'cargo':
        this.followCarrier();
        break;
      case 'disembark': {
        this.speed = Math.min(this.maxSpeed * 0.7, this.speed + dt * 2);
        this.move(dt);
        if (this.stateTime > 4 && heightAt(this.pos.x, this.pos.z) > 0.4) {
          this.carrier = null;
          this.pickPosition(ag(a, 105, 55) + rng.range(-10, 10), 0.3);
          this.setState('advance');
        }
        break;
      }
      case 'advance':
        if (this.drive(dt, 3) < 3.5 && this.speed < 0.6) this.setState('fire');
        break;
      case 'reposition':
        if (this.drive(dt, 2.5) < 3 && this.speed < 0.5) this.setState('fire');
        break;
      case 'fire': {
        this.speed = Math.max(0, this.speed - dt * 4);
        this.move(dt);
        this.fireTimer -= dt;
        const err = this.aimTurret(dt);
        if (this.fireTimer <= 0 && Math.abs(err) < 0.04) {
          this.shoot(a);
          this.fireTimer = ag(a, 10, 3.5) * rng.range(0.8, 1.25);
          if (rng.chance(ag(a, 0.15, 0.5))) {
            const side = rng.sign() * rng.range(10, 20);
            this.targetX = this.pos.x + Math.cos(this.yaw) * side;
            this.targetZ = this.pos.z - Math.sin(this.yaw) * side;
            this.setState('reposition');
          }
        }
        break;
      }
    }
    if (this.state !== 'fire' && this.state !== 'cargo') this.aimTurret(dt);
    this.recoil = Math.max(0, this.recoil - dt * 2.5);
    this.model.turret.rotation.y = this.turretYaw;
    this.model.gun.rotation.x = -this.gunElev;
    this.model.gun.position.z = this.baseGunZ - this.recoil * 0.5;
    if (this.loop) this.loop.setVolume(0.45 + Math.min(1, Math.abs(this.speed) / 4) * 0.55);
    this.smoke(dt, _v.set(0, 2.2, -1.5));
  }

  aimTurret(dt) {
    const want = this.faceAngleTo(0, 0);
    const err = wrapAngle(want - this.turretYaw);
    this.turretYaw += clamp(err, -0.35 * dt, 0.35 * dt);
    const d = Math.hypot(this.pos.x, this.pos.z);
    this.gunElev = Math.atan2(7 - (this.pos.y + 2.4), d) + 0.01;
    return err;
  }

  shoot(a) {
    this.model.muzzle.getWorldPosition(_v);
    this.game.enemyFire.tankShell(_v.clone(), rng.chance(ag(a, 0.25, 0.65)), 4);
    this.recoil = 1;
    this.game.effects.trail(this.pos.x, this.pos.y + 0.5, this.pos.z, 'dust');
  }

  onDestroyed() {
    const fx = this.game.effects;
    this.root.updateMatrixWorld(true);
    fx.explosion(this.pos.x, this.pos.y + 1.5, this.pos.z, 'L');
    if (this.state === 'cargo') return;
    this.wreck(1);
    // Sometimes the ammunition cooks off and throws the turret.
    if (rng.chance(0.35)) {
      this.turretFly = { vy: rng.range(9, 15), vx: rng.range(-3, 3), vz: rng.range(-3, 3), spin: rng.range(-4, 4), y: 0 };
    }
  }

  updateWreck(dt) {
    this.deadTime += dt;
    const t = this.turretFly;
    if (t) {
      const tur = this.model.turret;
      t.vy -= 9.8 * dt;
      tur.position.x += t.vx * dt;
      tur.position.y += t.vy * dt;
      tur.position.z += t.vz * dt;
      tur.rotation.x += t.spin * dt;
      tur.rotation.z += t.spin * 0.5 * dt;
      if (tur.position.y < 0.2 && t.vy < 0) {
        tur.position.y = 0.2;
        this.turretFly = null;
        this.game.effects.sandHit(this.pos.x + tur.position.x, this.pos.y, this.pos.z + tur.position.z, true);
      }
    }
  }
}
