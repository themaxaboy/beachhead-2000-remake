import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { rng } from '../core/rng.js';

const W = CONFIG.weapons;
const ORDER = ['mg', 'at', 'missile', 'pistol', 'howitzer'];
const _dir = new THREE.Vector3();
const _vis = new THREE.Vector3();
const _to = new THREE.Vector3();

/** Weapon selection, ammunition, rate of fire, reloads and missile lock-on. */
export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.ammo = { mg: 0, at: 0, missile: 0, howitzer: 0, pistol: W.pistol.magazine };
    this.current = 'mg';
    this.cooldown = 0;
    this.barrel = 0;
    this.reloadT = 0;
    this.atReady = true;
    this.lockTarget = null;
    this.lockTime = 0;
    this.firing = false;
    this.burstShots = 0;
    this.missileSide = 0;
    this.missileReload = [0, 0];
    this.kickPitch = 0;
    this.fireHeld = false;
    this.pistolLatch = false;
    this.shotsFired = 0;
  }

  reset(def) {
    this.ammo.mg = def.ammo.bullets;
    this.ammo.at = def.ammo.projectiles;
    this.ammo.missile = def.ammo.missiles;
    this.ammo.howitzer = def.ammo.howitzer;
    this.ammo.pistol = W.pistol.magazine;
    this.cooldown = 0;
    this.reloadT = 0;
    this.lockTarget = null;
    this.missileReload = [0, 0];
    this.select('mg', true);
  }

  get reloading() {
    return this.reloadT > 0 && (this.current === 'pistol' || this.current === 'at' || this.current === 'howitzer');
  }

  get reloadFraction() {
    if (this.current === 'at' && this.reloadT > 0) return 1 - this.reloadT / W.at.reload;
    if (this.current === 'howitzer' && this.reloadT > 0) return 1 - this.reloadT / W.howitzer.reload;
    if (this.current === 'pistol' && this.reloadT > 0) return 1 - this.reloadT / W.pistol.reload;
    return 1;
  }

  available(name) {
    if (name === 'howitzer') return this.ammo.howitzer > 0;
    return true;
  }

  select(name, immediate = false) {
    if (!ORDER.includes(name) || !this.available(name)) return;
    if (name === this.current && !immediate) return;
    const prev = this.current;
    this.current = name;
    this.cooldown = Math.max(this.cooldown, immediate ? 0 : 0.3);
    if (prev === 'at' || prev === 'howitzer') this.reloadT = 0;
    if (name === 'at' && this.ammo.at > 0) this.reloadT = 0;
    this.game.viewmodels?.setWeapon(name, immediate);
    if (!immediate) this.game.audio?.play('switch', { volume: 0.7 });
    this.game.hud?.weaponChanged(name);
  }

  toggle() {
    this.select(this.current === 'mg' ? 'at' : 'mg');
  }

  cycle(dir) {
    const avail = ORDER.filter((n) => this.available(n));
    const i = avail.indexOf(this.current);
    this.select(avail[(i + dir + avail.length) % avail.length]);
  }

  reload() {
    if (this.current === 'pistol' && this.ammo.pistol < W.pistol.magazine && this.reloadT <= 0) {
      this.reloadT = W.pistol.reload;
      this.game.audio?.play('pistolReload');
    }
  }

  aim(out) {
    return this.game.camera.getWorldDirection(out);
  }

  spread(dir, amount) {
    if (amount <= 0) return dir;
    const a = rng.gauss() * amount;
    const b = rng.range(0, Math.PI * 2);
    // perpendicular basis
    const up = Math.abs(dir.y) < 0.99 ? _to.set(0, 1, 0) : _to.set(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(dir, up).normalize();
    const v = new THREE.Vector3().crossVectors(dir, u);
    dir.addScaledVector(u, Math.cos(b) * Math.tan(a)).addScaledVector(v, Math.sin(b) * Math.tan(a)).normalize();
    return dir;
  }

  update(dt, fireDown) {
    const game = this.game;
    this.cooldown -= dt;
    this.missileReload[0] -= dt;
    this.missileReload[1] -= dt;
    if (this.missileReload[0] <= 0 && this.missileReload[0] > -dt * 1.5) game.viewmodels.reloadMissile(0);
    if (this.missileReload[1] <= 0 && this.missileReload[1] > -dt * 1.5) game.viewmodels.reloadMissile(1);
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        this.reloadT = 0;
        if (this.current === 'pistol') this.ammo.pistol = W.pistol.magazine;
        if (this.current === 'at' && this.ammo.at > 0) game.audio?.play('atReload');
      }
    }
    this.kickPitch = Math.max(0, this.kickPitch - dt * 3.2 * Math.max(0.3, this.kickPitch));

    this.updateLock(dt);

    const switching = game.viewmodels.switchT < 2;
    if (!fireDown) {
      if (this.burstShots > 6) game.audio?.play('mgTail', { volume: 0.8 });
      if (this.burstShots > 2) game.audio?.play('brass', { volume: 0.5, delay: 0.15 });
      this.burstShots = 0;
      this.pistolLatch = false;
    }
    this.fireHeld = fireDown;
    if (!fireDown || switching || this.cooldown > 0) return;

    switch (this.current) {
      case 'mg':
        if (this.ammo.mg <= 0) return this.empty();
        this.fireMG();
        break;
      case 'at':
        if (this.reloadT > 0) return;
        if (this.ammo.at <= 0) return this.empty();
        this.fireShell('at');
        break;
      case 'missile':
        if (this.ammo.missile <= 0) return this.empty();
        this.fireMissile();
        break;
      case 'pistol':
        if (this.reloadT > 0) return;
        if (this.ammo.pistol <= 0) {
          this.reload();
          return;
        }
        this.firePistol();
        break;
      case 'howitzer':
        if (this.reloadT > 0) return;
        if (this.ammo.howitzer <= 0) return this.empty();
        this.fireShell('howitzer');
        break;
    }
  }

  empty() {
    this.cooldown = 0.35;
    this.game.audio?.play('dryFire');
    if (this.current === 'mg' && this.game.settings.autoPistol) {
      this.game.hud.message('OUT OF AMMO — SHOOT THE SUPPLY CRATES', 'warn');
      this.select('pistol');
    } else {
      this.game.hud.message(`OUT OF ${W[this.current].label}`, 'warn');
    }
  }

  fireMG() {
    const game = this.game;
    this.cooldown += 1 / W.mg.rate;
    if (this.cooldown < 0) this.cooldown = 0;
    const which = this.barrel;
    this.barrel ^= 1;
    this.ammo.mg--;
    this.burstShots++;
    this.shotsFired++;
    this.aim(_dir);
    this.spread(_dir, W.mg.spread);
    game.viewmodels.muzzleWorld(which === 0 ? 'mgL' : 'mgR', _vis);
    game.projectiles.fireBullet(game.camera.position, _dir, W.mg.speed, _vis, 'mg');
    game.viewmodels.kick('mg', which);
    game.audio?.play('mg', { volume: 0.9 });
    game.effects.addTrauma(0.035);
    this.kickPitch = Math.min(0.012, this.kickPitch + 0.0012);
    game.muzzleFlashWorld(_vis, 0.6);
  }

  fireShell(kind) {
    const game = this.game;
    const cfg = W[kind];
    this.ammo[kind]--;
    this.shotsFired++;
    this.reloadT = cfg.reload;
    this.cooldown = 0.1;
    this.aim(_dir);
    if (cfg.spread) this.spread(_dir, cfg.spread);
    const key = kind === 'at' ? 'at' : 'howitzer';
    game.viewmodels.muzzleWorld(key, _vis);
    game.projectiles.fireShell(game.camera.position, _dir, cfg.speed, cfg.gravity, _vis, kind);
    game.viewmodels.kick(kind);
    game.audio?.play(kind === 'at' ? 'at' : 'howitzer');
    game.effects.addTrauma(kind === 'at' ? 0.35 : 0.6);
    this.kickPitch = kind === 'at' ? 0.02 : 0.035;
    game.muzzleFlashWorld(_vis, kind === 'at' ? 2 : 3);
    // muzzle smoke drifting in front of the turret
    const fx = game.effects;
    for (let i = 0; i < 6; i++) {
      fx.puff(fx.alpha, _vis.x + _dir.x * 2, _vis.y + _dir.y * 2, _vis.z + _dir.z * 2, _dir.x * rng.range(2, 6), rng.range(0.5, 1.5), _dir.z * rng.range(2, 6), rng.range(1.5, 3), 0.6, 3, [0.6, 0.6, 0.58], [0.5, 0.5, 0.5], 0.45, 1.2, -0.3, 0.05);
    }
    if (this.ammo[kind] <= 0) this.reloadT = 0;
  }

  fireMissile() {
    const game = this.game;
    const W2 = W.missile;
    if (game.projectiles.missilesAirborne >= W2.maxAirborne) return;
    let side = this.missileSide;
    if (this.missileReload[side] > 0) side ^= 1;
    if (this.missileReload[side] > 0) return;
    this.missileSide = side ^ 1;
    this.missileReload[side] = W2.reload * 2;
    this.cooldown = W2.reload;
    this.ammo.missile--;
    this.shotsFired++;
    this.aim(_dir);
    game.viewmodels.muzzleWorld(side === 0 ? 'missileL' : 'missileR', _vis);
    game.projectiles.fireMissile(game.camera.position, _dir, _vis, this.lockTarget && this.lockTime > 0.35 ? this.lockTarget : null);
    game.viewmodels.kick('missile', side);
    game.audio?.play('missileLaunch');
    game.effects.addTrauma(0.15);
  }

  firePistol() {
    const game = this.game;
    if (this.pistolLatch && this.cooldown > -0.05) return;
    this.cooldown = 1 / W.pistol.rate;
    this.ammo.pistol--;
    this.shotsFired++;
    this.aim(_dir);
    this.spread(_dir, W.pistol.spread);
    const cam = game.camera.position;
    _to.copy(cam).addScaledVector(_dir, W.pistol.range);
    const R = game.collision.segmentCast(cam.x, cam.y, cam.z, _to.x, _to.y, _to.z);
    if (R.hit) game.projectiles.bulletHit({ cls: 'pistol' }, R);
    game.viewmodels.kick('pistol');
    game.audio?.play('pistol');
    game.effects.addTrauma(0.05);
    this.kickPitch = Math.min(0.02, this.kickPitch + 0.008);
    if (this.ammo.pistol <= 0) this.reload();
  }

  /** Missile lock: the enemy vehicle or aircraft nearest the crosshair inside the lock cone. */
  updateLock(dt) {
    const game = this.game;
    if (this.current !== 'missile') {
      this.lockTarget = null;
      this.lockTime = 0;
      return;
    }
    this.aim(_dir);
    const cam = game.camera.position;
    let best = null;
    let bestAng = W.missile.lockCone;
    for (const e of game.entities.list) {
      if (!e.alive || !e.lockable || e.removed) continue;
      _to.subVectors(e.pos, cam);
      const d = _to.length();
      if (d > W.missile.lockRange || d < 15) continue;
      const ang = _to.angleTo(_dir);
      if (ang < bestAng) {
        bestAng = ang;
        best = e;
      }
    }
    if (best !== this.lockTarget) {
      this.lockTarget = best;
      this.lockTime = 0;
      if (best) game.audio?.play('lockTone', { bus: 'ui', volume: 0.5 });
    } else if (best) {
      const before = this.lockTime;
      this.lockTime += dt;
      if (before < 0.35 && this.lockTime >= 0.35) game.audio?.play('lockOnTone', { bus: 'ui', volume: 0.5 });
    }
  }

  addAmmo(kind, n) {
    this.ammo[kind] += n;
  }
}
