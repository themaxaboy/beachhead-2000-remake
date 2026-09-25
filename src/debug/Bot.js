import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { S_CARRIED, S_DYING, S_DEAD, S_FREE, S_FALLING } from '../entities/Infantry.js';

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const PRIORITY = { cobra: 78, tank: 72, apc: 70, ch53: 66, lct: 60, jet: 52 };

/**
 * Autopilot gunner used for balance testing (window.__bh.setBot(true)). It aims slightly imperfectly,
 * picks a weapon per target type and shoots supply crates, roughly like a competent player.
 */
export class Bot {
  constructor(game) {
    this.game = game;
    this.retarget = 0;
    this.target = null;
    this.skill = 1; // 1 = competent human
    this.reaction = 0;
    this.wob = Math.random() * 10;
  }

  update(dt) {
    const g = this.game;
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.valid(this.target)) {
      const prev = this.target;
      this.retarget = 0.4;
      this.choose();
      const same = prev && this.target && (prev.entity ? prev.entity === this.target.entity : prev.soldier === this.target.soldier);
      if (!same) this.reaction = 0.35 / this.skill;
    }
    this.reaction -= dt;
    this.wob += dt;
    const t = this.target;
    if (!t) {
      g.input.fire = false;
      return;
    }
    const w = g.weapons;
    if (w.current !== t.weapon) w.select(t.weapon, true);
    const err = this.aim(t, dt);
    const ready = w.current === 'missile' ? w.lockTime > 0.45 || !t.entity?.isAir : true;
    g.input.fire = ready && this.reaction <= 0 && err < 0.03;
  }

  valid(t) {
    if (!t) return false;
    const g = this.game;
    if (t.crate) return t.crate.active;
    if (t.soldier !== undefined) {
      const s = g.infantry.state[t.soldier];
      return s !== S_FREE && s !== S_DYING && s !== S_DEAD && s !== S_FALLING;
    }
    return t.entity.alive && !t.entity.removed;
  }

  choose() {
    const g = this.game;
    const w = g.weapons;
    const cam = g.camera.position;
    let best = null;
    const consider = (t, p) => {
      if (!best || p > best.p) best = { ...t, p };
    };
    for (const c of g.crates) if (c.active && c.pos.y > 3) consider({ crate: c, weapon: w.ammo.mg > 0 ? 'mg' : 'pistol' }, 100);
    g.infantry.forEachAlive((i) => {
      const inf = g.infantry;
      const d = Math.hypot(inf.x[i] - cam.x, inf.z[i] - cam.z);
      if (d > 260) return;
      const carried = inf.state[i] === S_CARRIED;
      consider({ soldier: i, weapon: w.ammo.mg > 0 ? 'mg' : 'pistol' }, (carried ? 40 : 90) - d / 6);
    });
    for (const e of g.entities.list) {
      if (!e.alive || e.removed || !(e.type in PRIORITY)) continue;
      const d = e.pos.distanceTo(cam);
      if (d > 1800) continue;
      if (e.type === 'lct' && !e.required) continue;
      let weapon;
      if (e.type === 'lct' || e.type === 'tank' || e.type === 'apc') weapon = w.ammo.at > 0 ? 'at' : w.ammo.missile > 0 ? 'missile' : null;
      else if (e.type === 'jet') weapon = w.ammo.missile > 0 ? 'missile' : 'mg';
      else weapon = d < 550 && w.ammo.mg > 0 ? 'mg' : w.ammo.missile > 0 ? 'missile' : 'mg';
      if (!weapon) continue;
      if (weapon === 'mg' && w.ammo.mg <= 0) continue;
      if (e.type === 'lct' && e.cargo === 'infantry' && d > 700) continue;
      consider({ entity: e, weapon }, PRIORITY[e.type] - d / 60);
    }
    this.target = best;
  }

  aim(t, dt) {
    const g = this.game;
    const cam = g.camera.position;
    let vel = null;
    if (t.crate) {
      _p.copy(t.crate.pos);
      vel = t.crate.vel;
    } else if (t.soldier !== undefined) {
      const s = g.infantry.sphereOf(t.soldier, {});
      _p.set(s.x, s.y, s.z);
    } else {
      _p.copy(t.entity.pos);
      if (!t.entity.isAir) _p.y += 1.2;
      vel = t.entity.vel;
    }
    const W = CONFIG.weapons;
    const speed = t.weapon === 'at' ? W.at.speed : t.weapon === 'mg' ? W.mg.speed : 0;
    if (speed && vel) {
      const tt = _p.distanceTo(cam) / speed;
      _p.addScaledVector(vel, tt);
    }
    const d = _p.distanceTo(cam);
    if (t.weapon === 'at') _p.y += 0.5 * W.at.gravity * (d / W.at.speed) ** 2;
    if (t.weapon === 'mg') _p.y += 0.5 * 9.81 * 0.3 * (d / W.mg.speed) ** 2;
    _v.subVectors(_p, cam);
    // human-like aim: limited turn speed and a slow wobble around the target
    const wobble = (0.7 / this.skill) * (Math.PI / 180);
    const wantYaw = Math.atan2(_v.x, -_v.z) + Math.sin(this.wob * 1.7) * wobble;
    const wantPitch = Math.atan2(_v.y, Math.hypot(_v.x, _v.z)) + Math.sin(this.wob * 2.3 + 1) * wobble * 0.7;
    let dy = Math.atan2(Math.sin(wantYaw - g.yaw), Math.cos(wantYaw - g.yaw));
    let dp = wantPitch - g.pitch;
    const maxYaw = 3.0 * this.skill * dt;
    const maxPitch = 1.8 * this.skill * dt;
    g.yaw += Math.max(-maxYaw, Math.min(maxYaw, dy * Math.min(1, dt * 12)));
    g.pitch += Math.max(-maxPitch, Math.min(maxPitch, dp * Math.min(1, dt * 12)));
    g.pitch = Math.max(CONFIG.camera.pitchMin, Math.min(CONFIG.camera.pitchMax, g.pitch));
    g.updateCamera(0);
    return Math.hypot(dy, dp);
  }
}
