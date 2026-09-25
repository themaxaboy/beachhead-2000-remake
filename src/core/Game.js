import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Renderer } from './Renderer.js';
import { Assets } from './Assets.js';
import { Input } from './Input.js';
import { Collision } from './Collision.js';
import { rng } from './rng.js';
import { clamp, lerp } from './math.js';
import { World } from '../world/World.js';
import { Bunker } from '../world/Bunker.js';
import { Effects } from '../fx/Effects.js';
import { EntityManager } from '../entities/EntityManager.js';
import { InfantrySystem } from '../entities/Infantry.js';
import { EnemyFire } from '../entities/EnemyFire.js';
import { Crate } from '../entities/Crate.js';
import { createMaterials } from '../entities/models/index.js';
import { Projectiles } from '../weapons/Projectiles.js';
import { WeaponSystem } from '../weapons/WeaponSystem.js';
import { Viewmodels } from '../weapons/Viewmodels.js';
import { LevelDirector } from '../level/LevelDirector.js';
import { generateLevel, LEVEL_COUNT } from '../data/levels.js';
import { UNITS } from '../data/units.js';
import { HUD } from '../ui/HUD.js';
import { Menus } from '../ui/Menus.js';
import { loadSettings, saveSettings, loadProgress, saveProgress } from '../ui/Storage.js';
import { AudioEngine } from '../audio/AudioEngine.js';

const _v = new THREE.Vector3();

export class Game {
  constructor(flags = {}) {
    this.flags = flags;
    this.settings = loadSettings();
    if (flags.quality) this.settings.quality = flags.quality;
    this.canvas = document.getElementById('game');
    this.renderer = new Renderer(this.canvas, this.settings.quality);
    this.scene = this.renderer.scene;
    this.camera = this.renderer.camera;
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    this.assets = new Assets(this.renderer.renderer);
    this.audio = flags.mute ? null : new AudioEngine();
    this.menus = new Menus(this);
    this.state = 'boot';
    this.time = 0;
    this.realTime = 0;
    this.yaw = 0;
    this.pitch = 0.02;
    this.score = 0;
    this.practice = false;
    this.crates = [];
    this.stateTimer = 0;
    this.fps = 60;
    this.fpsEl = document.getElementById('fps');
    this.lookDX = 0;
    this.lookDY = 0;
  }

  // ------------------------------------------------------------------ boot

  async boot() {
    this.menus.show('loading', { progress: 0, text: 'LOADING ASSETS' });
    this.frame = this.frame.bind(this);
    await this.assets.loadCore(CONFIG.timeOfDay.day.hdri, (p) => this.menus.show('loading', { progress: p * 0.9, text: 'LOADING ASSETS' }));
    const t = this.assets.textures;
    this.mats = createMaterials({ rustyMetal: t.rusty_metal, greenMetalRust: t.green_metal_rust, concrete: t.concrete });
    this.world = new World(this);
    this.effects = new Effects(this);
    this.collision = new Collision(this);
    this.entities = new EntityManager(this);
    this.level = new LevelDirector(this);
    this.level.def = generateLevel(this.flags.level || 1);
    this.infantry = new InfantrySystem(this);
    this.enemyFire = new EnemyFire(this);
    this.projectiles = new Projectiles(this);
    this.bunker = new Bunker(this);
    this.hud = new HUD(this);
    this.weapons = new WeaponSystem(this);
    this.viewmodels = new Viewmodels(this);
    this.weapons.reset(this.level.def);
    this.stats = this.newStats();

    // A world-space light for the player's own muzzle flashes (matters at night).
    this.muzzleLight = new THREE.PointLight(0xffb060, 0, 40, 2);
    this.scene.add(this.muzzleLight);

    this.input = new Input(this.canvas, { noLock: !!this.flags.nolock });
    this.input.onAction = (a) => this.onInputAction(a);
    this.input.onLockChange = (locked, error) => this.onLockChange(locked, error);

    await this.world.setTimeOfDay(this.level.def.timeOfDay);
    this.applyQuality();
    window.addEventListener('resize', () => this.effects.setScale(this.renderer.height * this.renderer.pixelRatio, this.camera.fov));
    this.menus.show('loading', { progress: 0.95, text: 'PREPARING SHADERS' });
    try {
      await this.renderer.renderer.compileAsync(this.scene, this.camera);
    } catch {
      /* optional */
    }
    this.initAudioOnGesture();
    this.state = 'menu';
    if (this.flags.autostart) this.startCampaign(this.flags.level || 1, !!this.flags.level);
    else this.menus.show('click');
    this.last = performance.now();
    requestAnimationFrame(this.frame);
    this.ready = true;
  }

  initAudioOnGesture() {
    if (!this.audio) return;
    const go = async () => {
      window.removeEventListener('pointerdown', go, true);
      window.removeEventListener('keydown', go, true);
      try {
        await this.audio.init();
        this.applyVolumes();
        this.audio.startAmbience();
      } catch (err) {
        console.warn('audio init failed', err);
      }
    };
    window.addEventListener('pointerdown', go, true);
    window.addEventListener('keydown', go, true);
  }

  newStats() {
    const kills = {};
    for (const k of Object.keys(UNITS)) kills[k] = 0;
    return { kills, damageTaken: 0, damageBy: {}, crates: 0 };
  }

  // ------------------------------------------------------------------ settings

  setSetting(k, v) {
    this.settings[k] = v;
    saveSettings(this.settings);
    if (k === 'quality') this.applyQuality();
    if (k === 'fov') {
      this.camera.fov = v;
      this.camera.updateProjectionMatrix();
      this.effects.setScale(this.renderer.height * this.renderer.pixelRatio, v);
    }
    if (k === 'master' || k === 'sfx' || k === 'ambience') this.applyVolumes();
  }

  applyQuality() {
    this.renderer.setQuality(this.settings.quality);
    const q = this.renderer.quality;
    this.world.setQuality(q);
    this.effects.configure(q, this.scene.fog, this.smokeLight());
    this.effects.setScale(this.renderer.height * this.renderer.pixelRatio, this.camera.fov);
  }

  applyVolumes() {
    const s = this.settings;
    this.audio?.ready && this.audio.setVolumes({ master: s.master, sfx: s.sfx, ambience: s.ambience, ui: 0.8 });
  }

  smokeLight() {
    const sky = this.world.sky;
    const k = sky.name === 'night' ? 0.25 : sky.name === 'dusk' ? 0.7 : 1.05;
    return new THREE.Color(k, k * 0.98, k * 0.95);
  }

  // ------------------------------------------------------------------ flow

  async startCampaign(n, practice) {
    this.practice = practice;
    this.score = 0;
    this.scoreSubmitted = false;
    await this.prepareLevel(n);
  }

  async prepareLevel(n) {
    const def = generateLevel(n);
    this.state = 'loading';
    this.menus.show('loading', { progress: 0.5, text: `MISSION ${String(n).padStart(2, '0')}` });
    this.hud.show(false);
    this.hud.clear();
    this.clearBattlefield();
    rng.reseed(this.flags.seed ? this.flags.seed * 1000 + n : (Math.random() * 2 ** 32) >>> 0);
    await this.world.setTimeOfDay(this.flags.time || def.timeOfDay);
    this.effects.configure(this.renderer.quality, this.scene.fog, this.smokeLight());
    this.level.start(def);
    this.weapons.reset(def);
    this.bunker.reset(CONFIG.rules.shieldCarryover && n > 1);
    this.stats = this.newStats();
    this.yaw = 0;
    this.pitch = 0.02;
    this.renderer.damage.uFade.value = 0;
    this.state = 'briefing';
    this.menus.show('briefing', { def, practice: this.practice });
    if (this.flags.autostart) this.beginLevel();
  }

  clearBattlefield() {
    this.entities.clear();
    this.infantry.reset();
    this.effects.clear();
    this.projectiles.clear();
    this.enemyFire.clear();
    for (const c of this.crates) c.dispose();
    this.crates.length = 0;
    this.world.obstacles.splice(0, this.world.obstacles.length, ...this.world.obstacles.filter((o) => !o.wreck));
  }

  beginLevel() {
    if (this.state !== 'briefing') return;
    this.pendingStart = true;
    this.input.requestLock();
    if (this.flags.nolock || this.flags.autostart) this.enterPlaying();
  }

  enterPlaying() {
    this.pendingStart = false;
    const first = this.state === 'briefing';
    this.state = 'playing';
    this.menus.hide();
    this.hud.show(true);
    this.input.enabled = true;
    this.audio?.resume();
    if (first) {
      this.audio?.play('levelStart', { bus: 'ui' });
      this.hud.message(`MISSION ${String(this.level.def.number).padStart(2, '0')} — DEFEND THE BEACH`, 'info');
    }
  }

  onLockChange(locked, error) {
    if (locked) {
      if (this.state === 'briefing' || this.state === 'paused') this.enterPlaying();
    } else if (this.state === 'playing') {
      this.pause();
    } else if (error && (this.state === 'briefing' || this.state === 'paused')) {
      this.hud.toast('CLICK AGAIN TO CONTINUE');
    }
  }

  onInputAction(a) {
    const w = this.weapons;
    if (a === 'pause' || a === 'blur') {
      if (this.state === 'playing' && (a === 'pause' || !this.flags.nolock)) this.pause();
      return;
    }
    if (this.state !== 'playing') return;
    switch (a) {
      case 'toggle':
        return w.toggle();
      case 'missile':
        return w.select('missile');
      case 'pistol':
        return w.select('pistol');
      case 'howitzer':
        return w.select('howitzer');
      case 'w1':
        return w.select('mg');
      case 'w2':
        return w.select('at');
      case 'w3':
        return w.select('missile');
      case 'w4':
        return w.select('pistol');
      case 'w5':
        return w.select('howitzer');
      case 'next':
        return w.cycle(1);
      case 'prev':
        return w.cycle(-1);
      case 'reload':
        return w.reload();
      case 'sensUp':
      case 'sensDown': {
        const s = clamp(this.settings.sensitivity + (a === 'sensUp' ? 1 : -1), 1, CONFIG.sensitivity.steps);
        this.setSetting('sensitivity', s);
        this.hud.toast(`MOUSE SENSITIVITY ${s}`);
        return;
      }
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.enabled = false;
    this.input.fire = false;
    this.input.exitLock();
    this.audio?.suspend();
    this.menus.show('pause');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.audio?.resume();
    this.input.requestLock();
    if (this.flags.nolock) this.enterPlaying();
  }

  quitToMenu() {
    this.renderer.damage.uFade.value = 0;
    this.input.enabled = false;
    this.input.exitLock();
    this.audio?.resume();
    this.clearBattlefield();
    this.hud.show(false);
    this.hud.clear();
    this.state = 'menu';
    this.menus.show('main');
  }

  onLevelComplete() {
    if (this.state !== 'playing') return;
    this.state = 'levelEnd';
    this.stateTimer = 0;
    this.hud.message('AREA SECURED', 'good');
    this.audio?.play('levelComplete', { bus: 'ui' });
  }

  showTally() {
    const def = this.level.def;
    const R = CONFIG.rules;
    const bonus = {
      shield: Math.round(this.bunker.shield) * R.shieldBonus,
      time: Math.round(this.level.timeLeft) * R.timeBonusPerSecond,
      level: def.number * R.levelBonus,
    };
    this.score += bonus.shield + bonus.time + bonus.level;
    if (!this.practice) {
      const p = loadProgress();
      p.highestLevel = Math.max(p.highestLevel, Math.min(LEVEL_COUNT, def.number + 1));
      saveProgress(p);
    }
    this.state = 'complete';
    this.input.enabled = false;
    this.input.exitLock();
    this.hud.show(false);
    this.menus.show('complete', { def, stats: this.stats, bonus, total: this.score });
  }

  continueNext() {
    const n = this.level.def.number;
    if (n >= LEVEL_COUNT) {
      this.state = 'victory';
      this.menus.show('victory', { score: this.score });
      return;
    }
    this.prepareLevel(n + 1);
  }

  onBunkerDestroyed() {
    if (this.state !== 'playing') return;
    this.state = 'dying';
    this.stateTimer = 0;
    this.input.enabled = false;
    this.input.fire = false;
    const p = this.bunker.pos;
    this.effects.explosion(p.x + 2, p.y, p.z - 3, 'L');
    this.audio?.play('gameOver', { bus: 'ui' });
  }

  showGameOver() {
    this.state = 'gameover';
    this.renderer.damage.uFade.value = 0.55;
    this.input.exitLock();
    this.hud.show(false);
    this.menus.show('gameover', { score: this.score, level: this.level.def.number, practice: this.practice });
  }

  // ------------------------------------------------------------------ scoring hooks

  addScore(n, pos) {
    this.score += n;
    if (pos) this.hud.popup(pos, `+${n}`);
  }

  onKill(entity, cause) {
    const def = entity.def;
    this.stats.kills[entity.type] = (this.stats.kills[entity.type] || 0) + 1;
    this.level.unitRemoved(entity);
    this.addScore(def.score, _v.copy(entity.pos).setY(entity.pos.y + 3));
    void cause;
  }

  onInfantryKill(i, cls, x, y, z) {
    const inChute = this.infantry.state[i] === 7 || this.infantry.state[i] === 8;
    this.stats.kills.infantry++;
    this.level.infantryRemoved(1);
    const pts = inChute ? 75 : UNITS.infantry.score;
    this.score += pts;
    if (rng.chance(0.25)) this.audio?.play('soldierDie', { position: _v.set(x, y, z), volume: 0.7 });
    if (cls === 'mg' || cls === 'pistol') this.hud.popup(_v.set(x, y + 1, z), `+${pts}`);
  }

  onCargoKill(type, cause, pos) {
    this.stats.kills[type] = (this.stats.kills[type] || 0) + 1;
    if (type === 'infantry') this.level.infantryRemoved(1);
    this.score += UNITS[type].score;
    void cause;
    void pos;
  }

  spawnCrate(kind, pos, vel) {
    this.crates.push(new Crate(this, kind, pos, vel));
  }

  collectCrate(crate) {
    const S = CONFIG.supply;
    this.stats.crates++;
    this.addScore(100, crate.pos);
    if (crate.kind === 'ammo') {
      this.weapons.addAmmo('mg', S.ammoBullets);
      this.weapons.addAmmo('missile', S.ammoMissiles);
      this.weapons.addAmmo('at', S.ammoProjectiles);
      this.hud.message(`AMMO +${S.ammoBullets} BULLETS +${S.ammoMissiles} MISSILES`, 'good');
    } else {
      this.bunker.heal(S.shield);
      this.hud.message(`SHIELD REPAIRED +${S.shield}`, 'good');
    }
    this.audio?.play('crateGet', { bus: 'ui' });
  }

  muzzleFlashWorld(pos, size) {
    this.muzzleLight.position.copy(pos);
    this.muzzleLight.intensity = 60 * size;
  }

  // ------------------------------------------------------------------ loop

  frame(now) {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.fps = lerp(this.fps, dt > 0 ? 1 / dt : 60, 0.05);
    this.tick(dt);
    if (!this.flags.norender) this.draw(dt);
  }

  applyLook() {
    const { dx, dy } = this.input.consumeLook();
    const S = CONFIG.sensitivity;
    const sens = S.base * Math.pow(S.factor, this.settings.sensitivity - S.default);
    this.yaw += dx * sens;
    this.pitch -= dy * sens * (this.settings.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, CONFIG.camera.pitchMin, CONFIG.camera.pitchMax);
    this.yaw = ((this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.lookDX = dx;
    this.lookDY = dy;
  }

  tick(dt) {
    this.realTime += dt;
    switch (this.state) {
      case 'playing':
        this.applyLook();
        this.stepSim(dt);
        break;
      case 'levelEnd':
        this.applyLook();
        this.stepSim(dt);
        this.stateTimer += dt;
        if (this.stateTimer > 2.5) this.showTally();
        break;
      case 'dying':
        this.stateTimer += dt;
        this.stepSim(dt * 0.35);
        this.renderer.damage.uFade.value = clamp((this.stateTimer - 1.2) / 2, 0, 1);
        this.effects.addTrauma(dt * 0.6);
        if (this.stateTimer > 3.4) this.showGameOver();
        break;
      case 'paused':
      case 'loading':
        break;
      default: {
        // menus: slow cinematic pan across the beach
        const t = this.realTime;
        this.yaw = Math.sin(t * 0.045) * 0.75;
        this.pitch = 0.03 + Math.sin(t * 0.07) * 0.02;
        this.lookDX = 0;
        this.lookDY = 0;
        this.effects.tracers.begin();
        this.effects.tracers.end();
        this.effects.update(dt);
        this.world.update(dt, this.camera);
        this.updateAudio(dt);
      }
    }
    this.updateCamera(dt);
  }

  stepSim(dt) {
    this.time += dt;
    const dmg = this.renderer.damage;
    dmg.uFlash.value = Math.max(0, dmg.uFlash.value - dt * 2.2);
    const playing = this.state === 'playing';
    if (this.bot && playing) this.bot.update(dt);
    this.weapons.update(dt, playing && this.input.fire);
    if (playing) this.level.update(dt);
    this.entities.update(dt);
    this.infantry.update(dt);
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      c.update(dt);
      if (c.removed) this.crates.splice(i, 1);
    }
    this.effects.tracers.begin();
    this.projectiles.update(dt);
    this.enemyFire.update(dt);
    this.effects.tracers.end();
    this.effects.update(dt);
    this.world.update(dt, this.camera);
    this.muzzleLight.intensity *= Math.exp(-dt * 40);
    this.updateAudio(dt);
  }

  updateAudio(dt) {
    if (!this.audio?.ready) return;
    this.audio.updateListener(this.camera);
    this.audio.update(dt);
  }

  updateCamera(dt) {
    const cam = this.camera;
    const tr = this.effects?.trauma || 0;
    const s = tr * tr;
    const t = this.realTime * 30;
    const shakeYaw = s * 0.035 * (Math.sin(t * 1.1) + Math.sin(t * 2.3 + 1.7) * 0.5);
    const shakePitch = s * 0.03 * (Math.sin(t * 1.3 + 0.5) + Math.sin(t * 2.9 + 2.1) * 0.5);
    const shakeRoll = s * 0.025 * Math.sin(t * 0.9 + 3.3);
    const kick = this.weapons?.kickPitch || 0;
    cam.position.set(0, CONFIG.camera.eyeHeight, 0);
    cam.rotation.set(this.pitch + kick + shakePitch, -this.yaw + shakeYaw, shakeRoll, 'YXZ');
    cam.updateMatrixWorld();
    void dt;
  }

  draw(dt) {
    const d = this.renderer.damage;
    const low = this.bunker && this.state === 'playing' && this.bunker.shield < 25 ? 0.5 + 0.5 * Math.sin(this.realTime * 6) : 0;
    d.uLow.value = low * (1 - this.bunker.shield / 25);
    this.viewmodels.update(dt, this.lookDX, this.lookDY);
    this.hud.update(dt);
    this.renderer.render(dt);
    if (this.settings.showFps || this.flags.debug) {
      const info = this.renderer.renderer.info;
      this.fpsEl.style.display = 'block';
      this.fpsEl.textContent = `${Math.round(this.fps)} FPS · ${info.render.calls} calls · ${Math.round(info.render.triangles / 1000)}k tris`;
    } else this.fpsEl.style.display = 'none';
  }

  /** Runs the simulation without rendering (tests / debug). */
  advance(seconds, step = 1 / 60) {
    const n = Math.round(seconds / step);
    for (let i = 0; i < n; i++) {
      if (this.state === 'playing' || this.state === 'levelEnd' || this.state === 'dying') {
        if (this.state === 'playing') this.applyLook();
        this.stepSim(step);
        if (this.state === 'levelEnd') {
          this.stateTimer += step;
          if (this.stateTimer > 2.5) this.showTally();
        }
        if (this.state === 'dying') {
          this.stateTimer += step;
          if (this.stateTimer > 3.4) this.showGameOver();
        }
      }
    }
    this.updateCamera(0);
  }
}
