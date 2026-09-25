import * as THREE from 'three';
import { Entity } from './Entity.js';
import { buildLandingCraft, applyCharred } from './models/index.js';
import { heightAt, shoreZ } from '../world/Terrain.js';
import { rng } from '../core/rng.js';
import { wrapAngle, clamp } from '../core/math.js';
import { Tank } from './Tank.js';
import { APC } from './APC.js';

const _v = new THREE.Vector3();
const _w = { y: 0, dx: 0, dz: 0 };
const SLOT_X = [-1.5, 0, 1.5];
const SLOT_Z = [-4.2, -1.4, 1.4, 4.2];

/** Landing craft: sails in, beaches, drops its ramp and unloads 12 troops, a tank or an APC. */
export class LandingCraft extends Entity {
  constructor(game, { x, z, landX, cargo }) {
    super(game, 'lct');
    this.radarKind = 'sea';
    this.model = buildLandingCraft(game.mats);
    this.root.add(this.model.root);
    this.deckY = this.model.deckY ?? 0.6;
    this.cargoZ = this.model.cargoZ ?? 0;
    for (const sz of [-8, -3, 2, 7]) this.addSphere(0, 1.4, sz, 3.4);
    this.pos.set(x, 0, z);
    this.landX = landX;
    this.landZ = shoreZ(landX);
    this.yaw = Math.atan2(this.landX - x, this.landZ - z);
    this.speed = 10;
    this.cargo = cargo;
    this.passengers = [];
    this.vehicle = null;
    this.ramp = 0;
    this.bob = rng.range(0, 10);
    this.wakeAcc = 0;
    this.unloadTimer = 0;
    this.sink = 0;
    this.setState('approach');
    this.sync();
    if (cargo === 'infantry') {
      const n = game.level.def.units.troopsPerLCT;
      for (let s = 0; s < n; s++) {
        const i = game.infantry.spawnCarried(this, s);
        if (i >= 0) this.passengers.push(i);
      }
    } else if (cargo === 'tank' || cargo === 'apc') {
      this.vehicle = cargo === 'tank' ? new Tank(game, this) : new APC(game, this);
      game.entities.add(this.vehicle);
      this.vehicle.followCarrier();
      this.vehicle.sync();
    }
    this.startLoop('lctLoop', 0.9);
  }

  /** World position of a cargo slot (slot -1 = centre of the well deck). */
  slotWorld(slot, out) {
    if (slot < 0) out.set(0, this.deckY, this.cargoZ);
    else out.set(SLOT_X[slot % 3], this.deckY, this.cargoZ + SLOT_Z[Math.floor(slot / 3) % 4]);
    return out.applyMatrix4(this.root.matrixWorld);
  }

  bowPoint(out, ahead = 11) {
    return out.set(this.pos.x + Math.sin(this.yaw) * ahead, 0, this.pos.z + Math.cos(this.yaw) * ahead);
  }

  /** Rides the same waves the ocean shader draws: height, pitch and roll from four hull points. */
  floatOnSea() {
    const ocean = this.game.world.ocean;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const L = 8;
    const W = 3;
    const { x, z } = this.pos;
    const bow = ocean.sample(x + fx * L, z + fz * L, _w).y;
    const stern = ocean.sample(x - fx * L, z - fz * L, _w).y;
    const right = ocean.sample(x + fz * W, z - fx * W, _w).y;
    const left = ocean.sample(x - fz * W, z + fx * W, _w).y;
    const bowUp = Math.atan2(bow - stern, 2 * L);
    return {
      y: (bow + stern + right + left) * 0.25,
      // Entity pitch is about world X (see Entity.sync), so project the bow elevation onto it.
      pitch: -bowUp * fz * 0.8,
      roll: Math.atan2(right - left, 2 * W) * 0.8,
    };
  }

  update(dt) {
    super.update(dt);
    this.bob += dt;
    this.wakeSpeed = 0;
    const sea = this.floatOnSea();
    let wantPitch = sea.pitch;
    let roll = sea.roll;
    let floatY = sea.y;

    if (!this.alive) {
      // sinking
      this.sink += dt;
      this.pos.y = floatY - this.sink * 0.35;
      this.pitch += dt * 0.02;
      this.roll += dt * 0.03 * Math.sign(this.roll || 1);
      if (this.sink > 12) this.remove();
      return;
    }

    switch (this.state) {
      case 'approach': {
        const want = Math.atan2(this.landX - this.pos.x, this.landZ - this.pos.z);
        this.yaw += clamp(wrapAngle(want - this.yaw), -0.15 * dt, 0.15 * dt);
        this.forward(dt, this.speed);
        wantPitch -= 0.035; // bow up under way
        this.bowPoint(_v);
        if (heightAt(_v.x, _v.z) > -0.9) {
          this.setState('beaching');
        }
        break;
      }
      case 'beaching':
        this.speed = Math.max(0, this.speed - dt * 8);
        this.forward(dt, this.speed);
        if (this.speed <= 0) {
          this.setState('ramp');
          this.game.audio?.play('rampDrop', { position: this.pos, delay: 1.2 });
        }
        break;
      case 'ramp':
        this.ramp = Math.min(1, this.ramp + dt / 1.4);
        if (this.ramp >= 1) {
          this.setState('unload');
          this.game.effects.splash(this.pos.x + Math.sin(this.yaw) * 12, this.pos.z + Math.cos(this.yaw) * 12, false);
        }
        break;
      case 'unload':
        this.unloadTimer -= dt;
        if (this.unloadTimer <= 0) {
          if (this.passengers.length) {
            this.unloadTimer = 0.32;
            const i = this.passengers.shift();
            this.bowPoint(_v, 16 + rng.range(0, 4));
            _v.x += Math.cos(this.yaw) * rng.range(-3, 3);
            _v.z -= Math.sin(this.yaw) * rng.range(-3, 3);
            if (this.game.infantry.carrier[i] === this) this.game.infantry.disembark(i, _v.x, _v.z);
          } else if (this.vehicle) {
            if (this.vehicle.alive) this.vehicle.disembark();
            this.vehicle = null;
            this.unloadTimer = 3.5;
          } else {
            this.required = false;
            this.game.level.unitRemoved(this);
            this.setState('raise');
          }
        }
        break;
      case 'raise':
        this.ramp = Math.max(0, this.ramp - dt / 1.6);
        if (this.ramp <= 0) this.setState('reverse');
        break;
      case 'reverse':
        this.forward(dt, -3);
        this.yaw += dt * 0.25 * (this.landX > 0 ? 1 : -1);
        if (this.stateTime > 7) this.setState('leave');
        break;
      case 'leave': {
        // head back out to sea, fanning slightly away from the centre
        const want = Math.atan2(Math.sign(this.pos.x || 1) * 0.3, -1);
        this.yaw += clamp(wrapAngle(want - this.yaw), -0.3 * dt, 0.3 * dt);
        this.forward(dt, Math.min(11, 2 + this.stateTime * 1.5));
        if (this.pos.z < shoreZ(this.pos.x) - 380 || this.stateTime > 90) this.withdraw();
        break;
      }
    }
    const beached = this.state === 'unload' || this.state === 'ramp';
    this.pitch += ((beached ? wantPitch * 0.3 : wantPitch) - this.pitch) * Math.min(1, dt * 2);
    this.roll += ((beached ? roll * 0.3 : roll) - this.roll) * Math.min(1, dt * 3);
    this.pos.y = beached ? floatY * 0.3 : floatY;
    this.model.ramp.rotation.x = this.ramp * 1.85; // tip rests on the sand
    this.smoke(dt, _v.set(0, 3, -8));
    // keep a carried vehicle glued to the deck (it updates before us in the entity list)
    if (this.vehicle && this.vehicle.state === 'cargo') {
      this.sync();
      this.vehicle.followCarrier();
      this.vehicle.sync();
    }
  }

  forward(dt, speed) {
    this.wakeSpeed = Math.abs(speed);
    this.vel.set(Math.sin(this.yaw) * speed, 0, Math.cos(this.yaw) * speed);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    if (Math.abs(speed) > 1) {
      this.wakeAcc += dt * Math.abs(speed) * 1.4;
      while (this.wakeAcc > 1) {
        this.wakeAcc -= 1;
        const side = rng.sign() * 3.4;
        const f = rng.range(-10, 10);
        this.game.effects.trail(
          this.pos.x + Math.sin(this.yaw) * f + Math.cos(this.yaw) * side,
          0,
          this.pos.z + Math.cos(this.yaw) * f - Math.sin(this.yaw) * side,
          'wake',
        );
      }
    }
  }

  onDestroyed(cause) {
    const fx = this.game.effects;
    fx.explosion(this.pos.x, 2, this.pos.z, 'M', { water: false });
    fx.waterColumn(this.pos.x + rng.range(-4, 4), this.pos.z + rng.range(-4, 4), 'M');
    this.game.infantry.killCarried(this, cause);
    this.passengers.length = 0;
    if (this.vehicle && this.vehicle.state === 'cargo') {
      this.vehicle.sinkWithCarrier(cause);
      this.vehicle = null;
    }
    applyCharred(this.root, this.game.mats);
    this.fireFx = fx.addFire(this.root, new THREE.Vector3(0, 2, -2), { duration: 14, size: 1.3 });
    if (this.loop) {
      this.loop.stop(0.5);
      this.loop = null;
    }
    this.solid = false;
  }
}
