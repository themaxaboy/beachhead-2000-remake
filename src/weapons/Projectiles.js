import * as THREE from 'three';
import { WEAPON_DAMAGE } from '../data/units.js';
import { rng } from '../core/rng.js';
import { heightAt } from '../world/Terrain.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

function makeMissileMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 1.5, 10).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xd9d6cc, roughness: 0.45, metalness: 0.3 }),
  );
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.07, 0.3, 10).rotateX(Math.PI / 2).translate(0, 0, 0.9),
    new THREE.MeshStandardMaterial({ color: 0x3a3a36, roughness: 0.3, metalness: 0.2 }),
  );
  const finMat = new THREE.MeshStandardMaterial({ color: 0x5c604a, roughness: 0.6 });
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.012, 0.22), finMat);
    fin.position.z = -0.62;
    fin.rotation.z = (i * Math.PI) / 2 + Math.PI / 4;
    g.add(fin);
  }
  g.add(body, nose);
  return g;
}

/** Player projectiles: machine-gun rounds, AT shells, howitzer shells and guided missiles. */
export class Projectiles {
  constructor(game) {
    this.game = game;
    this.bullets = [];
    this.shells = [];
    this.missiles = [];
    this.missileMeshes = [makeMissileMesh(), makeMissileMesh(), makeMissileMesh(), makeMissileMesh()];
  }

  clear() {
    this.bullets.length = 0;
    this.shells.length = 0;
    for (const m of this.missiles) this.game.scene.remove(m.mesh);
    this.missiles.length = 0;
    this.game.audio && this.missiles.forEach((m) => m.loop?.stop());
  }

  get missilesAirborne() {
    return this.missiles.length;
  }

  /** origin = eye position; dir = normalized; visual = world position of the barrel tip. */
  fireBullet(origin, dir, speed, visual, cls = 'mg') {
    this.bullets.push({
      x: origin.x,
      y: origin.y,
      z: origin.z,
      vx: dir.x * speed,
      vy: dir.y * speed,
      vz: dir.z * speed,
      ox: visual.x - origin.x,
      oy: visual.y - origin.y,
      oz: visual.z - origin.z,
      travel: 0,
      life: 1.6,
      cls,
    });
  }

  fireShell(origin, dir, speed, gravity, visual, cls) {
    this.shells.push({
      pos: origin.clone(),
      vel: dir.clone().multiplyScalar(speed),
      gravity,
      off: visual.clone().sub(origin),
      travel: 0,
      age: 0,
      acc: 0,
      cls,
    });
  }

  fireMissile(origin, dir, visual, target) {
    const mesh = this.missileMeshes.find((m) => !m.parent) || makeMissileMesh();
    mesh.position.copy(visual);
    this.game.scene.add(mesh);
    const loop = this.game.audio?.ready ? this.game.audio.loop('missileLoop', { position: visual, volume: 0.9 }) : null;
    this.missiles.push({
      pos: visual.clone(),
      vel: dir.clone().multiplyScalar(60),
      speed: 60,
      target,
      age: 0,
      acc: 0,
      mesh,
      loop,
      aimOrigin: origin.clone(),
    });
  }

  update(dt) {
    const game = this.game;
    const col = game.collision;
    const fx = game.effects;
    const tr = fx.tracers;

    // ---- bullets (swept segments)
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const x0 = b.x;
      const y0 = b.y;
      const z0 = b.z;
      b.vy -= 9.81 * 0.3 * dt;
      const x1 = x0 + b.vx * dt;
      const y1 = y0 + b.vy * dt;
      const z1 = z0 + b.vz * dt;
      b.life -= dt;
      const R = col.segmentCast(x0, y0, z0, x1, y1, z1);
      if (R.hit) {
        this.bulletHit(b, R);
        this.bullets.splice(i, 1);
        continue;
      }
      b.x = x1;
      b.y = y1;
      b.z = z1;
      b.travel += Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      if (b.life <= 0) {
        this.bullets.splice(i, 1);
        continue;
      }
      // tracer: starts at the barrel and converges onto the true path
      const k = Math.max(0, 1 - b.travel / 45);
      const len = Math.min(14, b.travel);
      const sp = Math.hypot(b.vx, b.vy, b.vz);
      const hx = b.x + b.ox * k;
      const hy = b.y + b.oy * k;
      const hz = b.z + b.oz * k;
      const k2 = Math.max(0, 1 - Math.max(0, b.travel - len) / 45);
      tr.add(
        b.x - (b.vx / sp) * len + b.ox * k2,
        b.y - (b.vy / sp) * len + b.oy * k2,
        b.z - (b.vz / sp) * len + b.oz * k2,
        hx,
        hy,
        hz,
        6.5,
        2.6,
        0.8,
        0.09,
      );
    }

    // ---- shells (ballistic)
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.age += dt;
      _p.copy(s.pos);
      s.vel.y -= s.gravity * dt;
      s.pos.addScaledVector(s.vel, dt);
      const R = col.segmentCast(_p.x, _p.y, _p.z, s.pos.x, s.pos.y, s.pos.z);
      if (R.hit) {
        this.explode(s.cls, _v.set(R.x, R.y, R.z), R);
        this.shells.splice(i, 1);
        continue;
      }
      s.travel += _p.distanceTo(s.pos);
      if (s.age > 12) {
        this.shells.splice(i, 1);
        continue;
      }
      const k = Math.max(0, 1 - s.travel / 40);
      _d.copy(s.vel).normalize();
      _v.copy(s.pos).addScaledVector(s.off, k);
      const big = s.cls === 'howitzer';
      tr.add(_v.x - _d.x * 4, _v.y - _d.y * 4, _v.z - _d.z * 4, _v.x, _v.y, _v.z, 9, 4, 1.2, big ? 0.35 : 0.22);
      s.acc += dt * 30;
      while (s.acc > 1) {
        s.acc -= 1;
        fx.puff(fx.alpha, _v.x, _v.y, _v.z, 0, 0.3, 0, 0.8, 0.3, 1.2, [0.7, 0.7, 0.68], [0.6, 0.6, 0.6], 0.3, 1, 0, 0.05);
      }
    }

    // ---- guided missiles
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.age += dt;
      m.speed = Math.min(240, m.speed + dt * 190);
      _d.copy(m.vel).normalize();
      // guidance
      let aim = null;
      if (m.target && m.target.alive && !m.target.removed) {
        const t = m.target;
        const dist = m.pos.distanceTo(t.pos);
        const tt = dist / m.speed;
        aim = _w.copy(t.pos).addScaledVector(t.vel, tt * 0.8);
        if (!t.isAir) aim.y += 1.2;
      } else if (m.age > 0.15) {
        // beam riding: follow the gunner's crosshair
        const cam = game.camera;
        cam.getWorldDirection(_v);
        const along = m.pos.distanceTo(cam.position) + 90;
        aim = _w.copy(cam.position).addScaledVector(_v, along);
      }
      if (aim) {
        _v.subVectors(aim, m.pos).normalize();
        const maxTurn = (m.target ? 2.6 : 2.0) * dt;
        const ang = _d.angleTo(_v);
        if (ang > 1e-4) {
          const k = Math.min(1, maxTurn / ang);
          _d.lerp(_v, k).normalize();
        }
      }
      m.vel.copy(_d).multiplyScalar(m.speed);
      _p.copy(m.pos);
      m.pos.addScaledVector(m.vel, dt);
      m.mesh.position.copy(m.pos);
      _v.copy(m.pos).add(_d);
      m.mesh.lookAt(_v);
      if (m.loop) {
        m.loop.setPosition(m.pos);
        m.loop.setVelocity(m.vel);
      }
      m.acc += dt * 50;
      while (m.acc > 1) {
        m.acc -= 1;
        fx.trail(m.pos.x - _d.x * 0.8, m.pos.y - _d.y * 0.8, m.pos.z - _d.z * 0.8, 'missile');
      }
      fx.flash(m.pos.x - _d.x * 0.9, m.pos.y - _d.y * 0.9, m.pos.z - _d.z * 0.9, 1.6, [8, 5, 2.5], 0.03);
      let boom = false;
      const R = col.segmentCast(_p.x, _p.y, _p.z, m.pos.x, m.pos.y, m.pos.z);
      if (R.hit) {
        this.explode('missile', _v.set(R.x, R.y, R.z), R);
        boom = true;
      } else if (m.target && m.target.alive && m.target.isAir && m.pos.distanceTo(m.target.pos) < 6) {
        // proximity fuse
        m.target.hit('missile', m.pos, true);
        this.explode('missile', _v.copy(m.pos), null, m.target);
        boom = true;
      } else if (m.age > 9) {
        this.explode('missile', _v.copy(m.pos), null);
        boom = true;
      }
      if (boom) {
        game.scene.remove(m.mesh);
        m.loop?.stop(0.1);
        this.missiles.splice(i, 1);
      }
    }
  }

  bulletHit(b, R) {
    const game = this.game;
    const fx = game.effects;
    const cls = b.cls;
    _v.set(R.x, R.y, R.z);
    switch (R.kind) {
      case 'entity':
        R.entity.hit(cls, _v, true);
        game.hud.hitMarker(false);
        break;
      case 'soldier': {
        const inf = game.infantry;
        const dmg = WEAPON_DAMAGE[cls].damage;
        const killed = inf.damage(R.soldier, cls, dmg, 0, 0);
        fx.bloodHit(R.x, R.y, R.z);
        if (killed) game.hud.hitMarker(true);
        break;
      }
      case 'crate':
        R.crate.collect();
        break;
      case 'water':
        fx.splash(R.x, R.z, true);
        if (rng.chance(0.08)) game.audio?.play('splash', { position: _v, volume: 0.5 });
        break;
      default:
        fx.sandHit(R.x, R.y, R.z);
        if (rng.chance(0.1)) game.audio?.play('impactSand', { position: _v, volume: 0.6 });
    }
  }

  /** Explosive impact with direct + splash damage. `direct` = entity already damaged by a proximity hit. */
  explode(cls, point, R, direct = null) {
    const game = this.game;
    const fx = game.effects;
    const info = WEAPON_DAMAGE[cls];
    let hitEntity = direct;
    if (R) {
      if (R.kind === 'entity') {
        R.entity.hit(cls, point, true);
        hitEntity = R.entity;
        game.hud.hitMarker(!R.entity.alive);
      } else if (R.kind === 'soldier') {
        game.infantry.kill(R.soldier, cls, point.x, point.z);
      } else if (R.kind === 'crate') {
        R.crate.collect();
      }
    }
    const size = cls === 'howitzer' ? 'L' : hitEntity && !hitEntity.isAir ? 'M' : cls === 'missile' ? 'M' : 'S';
    const water = R ? R.kind === 'water' : heightAt(point.x, point.z) < 0 && point.y < 1;
    fx.explosion(point.x, point.y, point.z, size, { air: point.y - Math.max(0, heightAt(point.x, point.z)) > 4, water });
    // splash damage
    const r = info.splashRadius || 0;
    if (r > 0) {
      for (const e of game.entities.list) {
        if (e === hitEntity || !e.alive || e.removed) continue;
        const d = e.pos.distanceTo(point) - e.radius * 0.5;
        if (d < r) e.hit(cls, null, false, 1 - Math.max(0, d) / r);
      }
      const kills = game.infantry.splash(point.x, point.y, point.z, r, cls);
      if (kills > 0) game.hud.hitMarker(true);
    }
  }
}
