import * as THREE from 'three';
import { heightAt } from '../world/Terrain.js';
import { rng } from '../core/rng.js';
import { CONFIG } from '../config.js';

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const BUNKER = new THREE.Vector3(...CONFIG.bunker.position);

/**
 * Enemy projectiles. Hit or miss is rolled when the shot is fired (from the unit's accuracy),
 * then a visible projectile flies to either the bunker or a nearby miss point.
 */
export class EnemyFire {
  constructor(game) {
    this.game = game;
    this.shots = [];
    this.pending = []; // queued burst rounds
    this.bombs = [];
    const bombGeo = new THREE.CylinderGeometry(0.18, 0.18, 1.5, 10);
    bombGeo.rotateX(Math.PI / 2);
    const nose = new THREE.SphereGeometry(0.18, 10, 6);
    nose.translate(0, 0, 0.75);
    this.bombMat = new THREE.MeshStandardMaterial({ color: 0x3c4030, roughness: 0.6, metalness: 0.4 });
    this.bombGeo = bombGeo;
    this.noseGeo = nose;
    this.grenadeGeo = new THREE.SphereGeometry(0.09, 8, 6);
    this.meshPool = [];
    this.lastRifleSound = 0;
  }

  clear() {
    for (const s of this.shots) if (s.mesh) this.releaseMesh(s.mesh);
    for (const b of this.bombs) this.releaseMesh(b.mesh);
    this.shots.length = 0;
    this.pending.length = 0;
    this.bombs.length = 0;
  }

  takeMesh(kind) {
    let m = this.meshPool.find((x) => x.userData.kind === kind && !x.parent);
    if (!m) {
      if (kind === 'bomb') {
        m = new THREE.Group();
        const body = new THREE.Mesh(this.bombGeo, this.bombMat);
        const n = new THREE.Mesh(this.noseGeo, this.bombMat);
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.04, 0.35), this.bombMat);
        fin.position.z = -0.7;
        const fin2 = fin.clone();
        fin2.rotation.z = Math.PI / 2;
        m.add(body, n, fin, fin2);
        m.traverse((o) => (o.castShadow = true));
      } else {
        m = new THREE.Mesh(this.grenadeGeo, this.bombMat);
      }
      m.userData.kind = kind;
      this.meshPool.push(m);
    }
    this.game.scene.add(m);
    return m;
  }

  releaseMesh(m) {
    if (m && m.parent) m.parent.remove(m);
  }

  /** Point on the bunker facing the shooter (hit) or a miss point in the sand / overhead. */
  targetPoint(from, hit, out, spread = 1) {
    _d.set(from.x - BUNKER.x, 0, from.z - BUNKER.z).normalize();
    if (hit) {
      return out.set(
        BUNKER.x + _d.x * 3.4 + rng.range(-1.2, 1.2),
        BUNKER.y + rng.range(-0.9, 0.6),
        BUNKER.z + _d.z * 3.4 + rng.range(-1.2, 1.2),
      );
    }
    if (rng.chance(0.35)) {
      // high: flies past the gunner's head
      const side = rng.sign();
      return out.set(
        BUNKER.x - _d.z * side * rng.range(1.5, 5) - _d.x * 30,
        BUNKER.y + rng.range(1.8, 5),
        BUNKER.z + _d.x * side * rng.range(1.5, 5) - _d.z * 30,
      );
    }
    const dist = rng.range(4, 22) * spread;
    const lat = rng.range(-8, 8) * spread;
    const x = BUNKER.x + _d.x * dist - _d.z * lat;
    const z = BUNKER.z + _d.z * dist + _d.x * lat;
    return out.set(x, Math.max(0, heightAt(x, z)), z);
  }

  /** Queues a burst of small-arms rounds. */
  burst(from, rounds, interval, opts) {
    for (let k = 0; k < rounds; k++) {
      this.pending.push({ t: k * interval, from: from.clone(), opts });
    }
    const now = this.game.time;
    const dist = from.length();
    if (opts.kind === 'rifle') {
      if (now - this.lastRifleSound > 0.05 || dist < 60) {
        this.game.audio?.play('rifle', { position: from, volume: 0.9 });
        this.lastRifleSound = now;
      }
    } else {
      this.game.audio?.play('enemyMG', { position: from, volume: 1 });
    }
    this.game.effects.muzzle(from.x, from.y, from.z, opts.kind === 'rifle' ? 0.6 : 1.1);
  }

  fireRound(from, opts) {
    const hit = rng.chance(opts.hitChance);
    const to = this.targetPoint(from, hit, new THREE.Vector3());
    const speed = opts.speed || 520;
    const dist = from.distanceTo(to);
    this.shots.push({
      kind: 'bullet',
      from,
      to,
      t: 0,
      dur: dist / speed,
      hit,
      damage: opts.damage,
      color: opts.color || [3, 1.6, 0.5],
      width: opts.width || 0.07,
      len: opts.len || 7,
      whizzed: false,
    });
  }

  tankShell(from, hit, damage) {
    const to = this.targetPoint(from, hit, new THREE.Vector3(), 0.6);
    const dist = from.distanceTo(to);
    this.shots.push({ kind: 'shell', from: from.clone(), to, t: 0, dur: dist / 420, hit, damage, color: [6, 3, 1], width: 0.25, len: 6 });
    this.game.audio?.play('tankFire', { position: from });
    this.game.effects.muzzle(from.x, from.y, from.z, 3.2);
  }

  rocket(from, hit, damage) {
    const to = this.targetPoint(from, hit, new THREE.Vector3(), 0.8);
    const dist = from.distanceTo(to);
    this.shots.push({ kind: 'rocket', from: from.clone(), to, t: 0, dur: dist / 190, hit, damage, color: [6, 3.5, 1.2], width: 0.2, len: 2.5, acc: 0 });
    this.game.audio?.play('rocketLaunch', { position: from });
  }

  grenade(from, hit) {
    const to = hit
      ? _v.set(rng.range(-2.5, 2.5), heightAt(0, 0) + 0.5, rng.range(-2.5, 2.5)).add(_d.set(from.x, 0, from.z).normalize().multiplyScalar(4))
      : this.targetPoint(from, false, _v, 0.4);
    const target = to.clone();
    target.y = Math.max(0, heightAt(target.x, target.z)) + 0.1;
    const mesh = this.takeMesh('grenade');
    this.shots.push({ kind: 'grenade', from: from.clone(), to: target, t: 0, dur: 1.5, hit, damage: 1.5, mesh, arc: 7 });
    this.game.audio?.play('grenadeThrow', { position: from, volume: 0.6 });
  }

  /** Free-falling bomb (jets and B-52s). */
  bomb(pos, vel, { big = false, whistle = false } = {}) {
    const mesh = this.takeMesh('bomb');
    mesh.position.copy(pos);
    mesh.scale.setScalar(big ? 1.3 : 1);
    const b = { pos: pos.clone(), vel: vel.clone(), mesh, big, whistled: !whistle };
    this.bombs.push(b);
  }

  update(dt) {
    const game = this.game;
    const fx = game.effects;
    const cam = game.camera.position;

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.t -= dt;
      if (p.t <= 0) {
        this.pending.splice(i, 1);
        this.fireRound(p.from, p.opts);
      }
    }

    const tr = fx.tracers;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      if (s.kind === 'grenade') {
        _v.lerpVectors(s.from, s.to, k);
        _v.y += Math.sin(k * Math.PI) * s.arc;
        s.mesh.position.copy(_v);
      } else {
        _v.lerpVectors(s.from, s.to, k);
        _d.subVectors(s.to, s.from).normalize();
        const len = Math.min(s.len, s.from.distanceTo(_v));
        tr.add(_v.x - _d.x * len, _v.y - _d.y * len, _v.z - _d.z * len, _v.x, _v.y, _v.z, s.color[0], s.color[1], s.color[2], s.width);
        if (s.kind === 'rocket') {
          s.acc += dt * 60;
          while (s.acc >= 1) {
            s.acc -= 1;
            fx.trail(_v.x, _v.y, _v.z, 'rocket');
          }
        }
        if (s.kind === 'bullet' && !s.whizzed && !s.hit && _v.distanceTo(cam) < 6) {
          s.whizzed = true;
          game.audio?.play('whizz', { position: _v, volume: 0.8 });
        }
      }
      if (k >= 1) {
        this.shots.splice(i, 1);
        this.impact(s);
      }
    }

    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.vel.y -= 9.81 * dt;
      b.vel.multiplyScalar(1 - 0.02 * dt);
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);
      _v.copy(b.pos).add(b.vel);
      b.mesh.lookAt(_v);
      const ground = heightAt(b.pos.x, b.pos.z);
      if (!b.whistled) {
        const tImpact = (b.pos.y - Math.max(0, ground)) / Math.max(1, -b.vel.y);
        if (tImpact < 2.2 && Math.hypot(b.pos.x, b.pos.z) < 160) {
          b.whistled = true;
          game.audio?.play('bombWhistle', { position: b.pos });
        }
      }
      if (b.pos.y <= Math.max(0, ground)) {
        this.bombs.splice(i, 1);
        this.releaseMesh(b.mesh);
        const x = b.pos.x;
        const z = b.pos.z;
        fx.explosion(x, Math.max(0, ground), z, b.big ? 'L' : 'M');
        const d = Math.hypot(x - BUNKER.x, z - BUNKER.z);
        if (b.big) {
          if (d < 15) game.bunker.damage(5, b.pos);
          else if (d < 35) game.bunker.damage(2, b.pos);
        } else if (d < 8) game.bunker.damage(7, b.pos);
        else if (d < 20) game.bunker.damage(3, b.pos);
        // bombs also hurt their own troops
        game.infantry.splash(x, ground, z, b.big ? 14 : 10, 'bomb');
      }
    }
  }

  impact(s) {
    const game = this.game;
    const fx = game.effects;
    const p = s.to;
    const water = heightAt(p.x, p.z) < 0 && p.y < 0.5;
    switch (s.kind) {
      case 'bullet':
        if (s.hit) {
          game.bunker.damage(s.damage, s.from);
          fx.metalHit(p.x, p.y, p.z);
          if (rng.chance(0.3)) game.audio?.play('impactMetal', { position: p, volume: 0.7 });
        } else if (p.y < heightAt(p.x, p.z) + 1) {
          if (water) fx.splash(p.x, p.z, true);
          else fx.sandHit(p.x, p.y, p.z);
          if (rng.chance(0.15)) game.audio?.play('impactSand', { position: p, volume: 0.6 });
        }
        break;
      case 'shell':
        fx.explosion(p.x, p.y, p.z, 'S');
        if (s.hit) game.bunker.damage(s.damage, s.from);
        else if (p.length() < 12) game.bunker.damage(s.damage * 0.2, s.from);
        break;
      case 'rocket':
        fx.explosion(p.x, p.y, p.z, 'S');
        if (s.hit) game.bunker.damage(s.damage, s.from);
        break;
      case 'grenade':
        this.releaseMesh(s.mesh);
        fx.explosion(p.x, p.y, p.z, 'S', { sound: true });
        if (s.hit) game.bunker.damage(s.damage, s.from);
        break;
    }
  }
}
