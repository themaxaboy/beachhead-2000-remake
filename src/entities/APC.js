import * as THREE from 'three';
import { GroundVehicle } from './GroundVehicle.js';
import { buildAPC } from './models/index.js';
import { heightAt } from '../world/Terrain.js';
import { aggressionLerp as ag } from '../config.js';
import { rng } from '../core/rng.js';
import { wrapAngle, clamp } from '../core/math.js';

const _v = new THREE.Vector3();

/** M113 APC: carries six riflemen up the beach, drops them, then supports with its .50 cal. */
export class APC extends GroundVehicle {
  constructor(game, carrier) {
    super(game, 'apc', carrier);
    this.model = buildAPC(game.mats);
    this.root.add(this.model.root);
    this.addSphere(0, 1.2, 1.4, 1.8);
    this.addSphere(0, 1.2, -1.2, 1.8);
    this.length = 4.9;
    this.maxSpeed = 6;
    this.troops = game.level.def.units.troopsPerAPC;
    this.mgYaw = 0;
    this.fireTimer = rng.range(2, 4);
    this.unloadTimer = 0;
    this.ramp = 0;
  }

  disembark() {
    this.setState('disembark');
    this.startLoop('apcLoop', 0.8);
  }

  update(dt) {
    super.update(dt);
    if (!this.alive) return;
    const a = this.aggression.tank;
    switch (this.state) {
      case 'cargo':
        this.followCarrier();
        break;
      case 'disembark':
        this.speed = Math.min(this.maxSpeed * 0.7, this.speed + dt * 2.5);
        this.move(dt);
        if (this.stateTime > 3.5 && heightAt(this.pos.x, this.pos.z) > 0.4) {
          this.carrier = null;
          this.pickPosition(rng.range(62, 90), 0.35);
          this.setState('advance');
        }
        break;
      case 'advance':
        if (this.drive(dt, 3) < 3.5 && this.speed < 0.6) this.setState('unload');
        break;
      case 'unload': {
        this.speed = Math.max(0, this.speed - dt * 5);
        this.move(dt);
        this.ramp = Math.min(1, this.ramp + dt * 0.9);
        if (this.ramp >= 1) {
          this.unloadTimer -= dt;
          if (this.troops > 0 && this.unloadTimer <= 0) {
            this.unloadTimer = 0.45;
            this.troops--;
            const bx = this.pos.x - Math.sin(this.yaw) * 3.4 + rng.range(-0.6, 0.6);
            const bz = this.pos.z - Math.cos(this.yaw) * 3.4;
            const wx = bx + Math.cos(this.yaw) * rng.range(-5, 5);
            const wz = bz - Math.sin(this.yaw) * rng.range(-5, 5);
            this.game.infantry.spawnRunning(bx, bz, this.yaw + Math.PI, wx, wz);
          }
          if (this.troops <= 0) {
            this.pickPosition(rng.range(42, 55), 0.15);
            this.setState('close');
          }
        }
        break;
      }
      case 'close':
        this.ramp = Math.max(0, this.ramp - dt);
        if (this.drive(dt, 2.5) < 3 && this.speed < 0.5) this.setState('fire');
        break;
      case 'fire': {
        this.speed = Math.max(0, this.speed - dt * 5);
        this.move(dt);
        this.fireTimer -= dt;
        if (this.fireTimer <= 0 && Math.hypot(this.pos.x, this.pos.z) < 140) {
          this.model.muzzle.getWorldPosition(_v);
          this.game.enemyFire.burst(_v.clone(), 8, 0.09, {
            kind: 'mg',
            hitChance: ag(a, 0.25, 0.7),
            damage: 0.2,
            color: [4, 2.2, 0.6],
            width: 0.1,
          });
          this.fireTimer = ag(a, 7, 2.5) * rng.range(0.8, 1.3);
          if (rng.chance(0.2)) {
            const side = rng.sign() * rng.range(8, 14);
            this.targetX = this.pos.x + Math.cos(this.yaw) * side;
            this.targetZ = this.pos.z - Math.sin(this.yaw) * side;
            this.setState('close');
          }
        }
        break;
      }
    }
    const want = this.faceAngleTo(0, 0);
    this.mgYaw += clamp(wrapAngle(want - this.mgYaw), -1.5 * dt, 1.5 * dt);
    this.model.mg.rotation.y = this.mgYaw;
    this.model.ramp.rotation.x = this.ramp * 1.35;
    if (this.loop) this.loop.setVolume(0.4 + Math.min(1, Math.abs(this.speed) / 4) * 0.6);
    this.smoke(dt, _v.set(0, 2, 0));
  }

  onDestroyed(cause) {
    this.game.effects.explosion(this.pos.x, this.pos.y + 1.2, this.pos.z, 'M');
    // troops still inside die with it
    for (let i = 0; i < this.troops; i++) this.game.onCargoKill('infantry', cause, this.pos);
    this.troops = 0;
    if (this.state === 'cargo') return;
    this.wreck(0.9);
  }
}
