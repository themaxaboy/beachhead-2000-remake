import * as THREE from 'three';
import { buildSupplyCrate, buildParachute } from './models/index.js';
import { heightAt } from '../world/Terrain.js';
import { rng } from '../core/rng.js';

/** Parachuted supply crate: must be shot before it touches the ground. */
export class Crate {
  constructor(game, kind, pos, vel) {
    this.game = game;
    this.kind = kind; // 'ammo' | 'shield'
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.active = true;
    this.t = 0;
    this.state = 'fall';
    this.root = new THREE.Group();
    this.crate = buildSupplyCrate(game.mats, kind);
    this.chute = buildParachute(game.mats, 3.6, true);
    this.chute.root.scale.setScalar(0.05);
    this.root.add(this.crate.root, this.chute.root);
    this.root.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.drift = new THREE.Vector3(rng.range(-1.5, 1.5), 0, rng.range(-1.5, 1.5));
    this.swing = rng.range(0, 6);
    game.scene.add(this.root);
    this.sync();
  }

  get radarKind() {
    return 'crate';
  }

  update(dt) {
    this.t += dt;
    if (this.state === 'fall') {
      this.vel.y -= 9.81 * dt;
      this.vel.multiplyScalar(1 - 0.3 * dt);
      if (this.t > 1.4) {
        this.state = 'chute';
        this.game.audio?.play('chutePop', { position: this.pos });
      }
    } else if (this.state === 'chute') {
      const open = Math.min(1, (this.t - 1.4) / 1.0);
      this.chute.root.scale.setScalar(0.1 + open * 0.9);
      this.vel.x += (this.drift.x - this.vel.x) * dt;
      this.vel.z += (this.drift.z - this.vel.z) * dt;
      this.vel.y += (-6 - this.vel.y) * Math.min(1, dt * 2.5);
    } else if (this.state === 'landed') {
      if (this.t > 10) this.dispose();
      return;
    }
    this.pos.addScaledVector(this.vel, dt);
    const g = Math.max(0, heightAt(this.pos.x, this.pos.z));
    if (this.pos.y <= g + 0.6) {
      this.pos.y = g + 0.6;
      this.land(g);
    }
    this.sync();
  }

  sync() {
    this.root.position.copy(this.pos);
    const s = Math.sin(this.t * 1.3 + this.swing);
    this.root.rotation.set(s * 0.08, this.t * 0.2, Math.cos(this.t * 1.1 + this.swing) * 0.08);
  }

  land(g) {
    this.state = 'landed';
    this.active = false;
    this.t = 0;
    this.chute.root.visible = false;
    if (g <= 0.01) {
      this.game.effects.splash(this.pos.x, this.pos.z, false);
      this.dispose();
    } else {
      this.game.effects.sandHit(this.pos.x, g, this.pos.z, true);
    }
    this.game.hud.message('SUPPLY LOST', 'warn');
  }

  collect() {
    if (!this.active) return;
    this.active = false;
    this.game.collectCrate(this);
    this.game.effects.flash(this.pos.x, this.pos.y, this.pos.z, 4, [6, 6, 4], 0.2);
    this.game.effects.spark(this.pos.x, this.pos.y, this.pos.z, 8, 12, 0.6, 0.15);
    this.dispose();
  }

  dispose() {
    this.active = false;
    this.removed = true;
    this.game.scene.remove(this.root);
  }
}
