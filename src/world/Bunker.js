import * as THREE from 'three';
import { CONFIG } from '../config.js';

/** The player's bunker: a single shield value; the game ends when it reaches zero. */
export class Bunker {
  constructor(game) {
    this.game = game;
    this.pos = new THREE.Vector3(...CONFIG.bunker.position);
    this.max = CONFIG.bunker.shield;
    this.shield = this.max;
    this.invulnerable = false;
    this.lastAlarm = -10;
    this.lastHitSound = -10;
  }

  reset(keep = false) {
    if (!keep) this.shield = this.max;
  }

  heal(amount) {
    this.shield = Math.min(this.max, this.shield + amount);
  }

  damage(amount, from) {
    const game = this.game;
    if (this.shield <= 0 || game.state !== 'playing') return;
    if (!this.invulnerable) this.shield = Math.max(0, this.shield - amount);
    game.stats.damageTaken += amount;
    const r = game.renderer.damage;
    r.uFlash.value = Math.min(1, r.uFlash.value + Math.min(0.7, amount * 0.12 + 0.05));
    game.effects.addTrauma(Math.min(0.6, 0.06 * amount + 0.02));
    if (from) game.hud.damageFrom(from);
    if (amount >= 1 && game.time - this.lastHitSound > 0.08) {
      this.lastHitSound = game.time;
      game.audio?.play('bunkerHit', { volume: Math.min(1, 0.4 + amount * 0.1) });
    }
    if (this.shield < 25 && game.time - this.lastAlarm > 6) {
      this.lastAlarm = game.time;
      game.audio?.play('alarm', { bus: 'ui' });
      game.hud.message('SHIELD CRITICAL', 'danger');
    }
    if (this.shield <= 0) game.onBunkerDestroyed();
  }
}
