import * as THREE from 'three';
import { UNITS, WEAPON_DAMAGE } from '../data/units.js';
import { heightAt } from '../world/Terrain.js';
import { rng } from '../core/rng.js';

const _v = new THREE.Vector3();
let nextId = 1;

/**
 * Base class for vehicles and aircraft. Infantry are handled separately by InfantrySystem.
 * Hit volumes are a handful of spheres in local space.
 */
export class Entity {
  constructor(game, type) {
    this.game = game;
    this.id = nextId++;
    this.type = type;
    this.def = UNITS[type] || { hp: 1, score: 0, force: 0, armor: {} };
    this.hp = this.def.hp;
    this.maxHp = this.def.hp;
    this.alive = true;
    this.removed = false;
    this.required = true; // must be destroyed to finish the mission
    this.withdrawn = false;
    this.solid = true; // blocks bullets (wrecks stay solid)
    this.isAir = false;
    this.lockable = true;
    this.radarKind = 'ground';
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';
    this.spheres = []; // [{c: Vector3 local, r}]
    this.worldSpheres = [];
    this.radius = 5;
    this.state = '';
    this.stateTime = 0;
    this.deadTime = 0;
    this.loop = null;
    this.smokeAcc = 0;
    game.scene.add(this.root);
  }

  addSphere(x, y, z, r) {
    this.spheres.push({ c: new THREE.Vector3(x, y, z), r });
    this.worldSpheres.push({ x: 0, y: 0, z: 0, r });
    let far = 0;
    for (const s of this.spheres) far = Math.max(far, s.c.length() + s.r);
    this.radius = far;
  }

  setState(s) {
    this.state = s;
    this.stateTime = 0;
  }

  get aggression() {
    return this.game.level.def.aggression;
  }

  groundY(x = this.pos.x, z = this.pos.z) {
    return heightAt(x, z);
  }

  distanceToBunker() {
    return Math.hypot(this.pos.x, this.pos.z);
  }

  update(dt) {
    this.stateTime += dt;
  }

  sync() {
    this.root.position.copy(this.pos);
    this.root.rotation.set(this.pitch, this.yaw, this.roll);
    this.root.updateMatrixWorld(true);
    const m = this.root.matrixWorld;
    for (let i = 0; i < this.spheres.length; i++) {
      _v.copy(this.spheres[i].c).applyMatrix4(m);
      const w = this.worldSpheres[i];
      w.x = _v.x;
      w.y = _v.y;
      w.z = _v.z;
    }
    if (this.loop) {
      this.loop.setPosition(this.pos);
      this.loop.setVelocity(this.vel);
    }
  }

  /** Applies weapon damage. Returns the damage actually dealt. */
  hit(weaponClass, point, direct = true, scale = 1) {
    if (!this.alive) {
      if (point && direct) this.game.effects.metalHit(point.x, point.y, point.z);
      return 0;
    }
    const base = direct ? WEAPON_DAMAGE[weaponClass].damage : WEAPON_DAMAGE[weaponClass].splash || 0;
    const dmg = base * scale * (this.def.armor[weaponClass] ?? 1);
    if (point && direct) {
      if (weaponClass === 'mg' || weaponClass === 'pistol') {
        this.game.effects.metalHit(point.x, point.y, point.z);
        if (rng.chance(0.25)) this.game.audio?.play(dmg < 3 ? 'ricochet' : 'impactMetal', { position: point });
      }
    }
    if (dmg <= 0) return 0;
    this.hp -= dmg;
    this.onDamaged(dmg, weaponClass);
    if (this.hp <= 0) {
      this.hp = 0;
      this.destroy(weaponClass);
    }
    return dmg;
  }

  onDamaged() {}

  destroy(cause) {
    if (!this.alive) return;
    this.alive = false;
    this.required = false;
    this.deadTime = 0;
    this.game.onKill(this, cause);
    this.onDestroyed(cause);
  }

  onDestroyed() {}

  /** Leaves the battle without being destroyed (empty landing craft, transport helicopter). */
  withdraw() {
    this.withdrawn = true;
    this.required = false;
    this.remove();
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    this.alive = false;
    this.game.scene.remove(this.root);
    if (this.loop) {
      this.loop.stop(0.4);
      this.loop = null;
    }
  }

  startLoop(name, volume = 1) {
    if (this.game.audio?.ready) this.loop = this.game.audio.loop(name, { position: this.pos, volume });
  }

  /** Damaged smoke trail helper. */
  smoke(dt, offset, kind = 'damaged') {
    if (this.hp > this.maxHp * 0.5 && this.alive) return;
    this.smokeAcc += dt * (this.alive ? 10 : 18);
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      _v.copy(offset).applyMatrix4(this.root.matrixWorld);
      this.game.effects.trail(_v.x, _v.y, _v.z, kind);
    }
  }
}
