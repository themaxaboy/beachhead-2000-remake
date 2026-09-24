import * as THREE from 'three';
import { ParticleSystem } from './Particles.js';
import { Tracers } from './Tracers.js';
import { makeSmokeAtlas, makeGlowTexture, makeScorchTexture, makeRingTexture } from './TextureFactory.js';
import { heightAt, normalAt } from '../world/Terrain.js';

const P = {}; // reusable spawn parameter object
const rand = (a, b) => a + Math.random() * (b - a);
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler();
const _spin = new THREE.Quaternion();

const FIRE0 = [7, 3.6, 1.2];
const FIRE1 = [1.4, 0.3, 0.05];
const SMOKE_DARK = [0.09, 0.085, 0.08];
const SMOKE_MID = [0.32, 0.31, 0.3];
const SAND = [0.78, 0.69, 0.55];
const SAND_DARK = [0.45, 0.38, 0.3];
const WATER = [0.9, 0.94, 0.97];
const SPARK = [7, 3.8, 1.4];

const SIZES = {
  S: { fire: 6, fireSize: [2, 5], smoke: 7, smokeSize: [3, 9], sparks: 10, debris: 0, light: 900, lightR: 40, shake: 0.35, radius: 60, sound: 'explosionS', scorch: 3 },
  M: { fire: 12, fireSize: [4, 10], smoke: 16, smokeSize: [5, 17], sparks: 28, debris: 10, light: 4000, lightR: 90, shake: 0.6, radius: 110, sound: 'explosionM', scorch: 6 },
  L: { fire: 22, fireSize: [7, 17], smoke: 30, smokeSize: [8, 28], sparks: 44, debris: 22, light: 14000, lightR: 170, shake: 0.9, radius: 170, sound: 'explosionL', scorch: 10 },
};

export class Effects {
  constructor(game) {
    this.game = game;
    const scene = game.scene;
    this.add = new ParticleSystem(5000, makeSmokeAtlas(), { additive: true, atlas: true });
    this.alpha = new ParticleSystem(5000, makeSmokeAtlas(), { additive: false, atlas: true });
    this.glow = new ParticleSystem(1500, makeGlowTexture(), { additive: true, atlas: false });
    scene.add(this.alpha.points, this.add.points, this.glow.points);
    this.tracers = new Tracers(500);
    scene.add(this.tracers.mesh);

    // Pooled explosion lights: always in the scene so the shader never recompiles.
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 100, 2);
      l.userData = { t: 0, dur: 0, peak: 0 };
      scene.add(l);
      this.lights.push(l);
    }
    this.flareLight = new THREE.PointLight(0xfff2d0, 0, 900, 1.2);
    scene.add(this.flareLight);

    // Debris chunks.
    const chunk = new THREE.DodecahedronGeometry(0.35, 0);
    chunk.scale(1, 0.6, 0.8);
    this.debrisMax = 160;
    this.debris = new THREE.InstancedMesh(
      chunk,
      new THREE.MeshStandardMaterial({ color: 0x2b2824, roughness: 0.9, metalness: 0.2 }),
      this.debrisMax,
    );
    this.debris.castShadow = true;
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    this.debrisData = [];
    scene.add(this.debris);

    // Scorch decals on the sand.
    this.decalMax = 72;
    const decalGeo = new THREE.PlaneGeometry(1, 1);
    decalGeo.rotateX(-Math.PI / 2);
    this.decals = new THREE.InstancedMesh(
      decalGeo,
      new THREE.MeshStandardMaterial({
        map: makeScorchTexture(),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        roughness: 1,
      }),
      this.decalMax,
    );
    this.decals.receiveShadow = true;
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decalNext = 0;
    scene.add(this.decals);

    // Shockwave / water rings.
    this.rings = [];
    const ringMat = new THREE.MeshBasicMaterial({
      map: makeRingTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
    });
    const ringGeo = new THREE.PlaneGeometry(1, 1);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(ringGeo, ringMat.clone());
      m.visible = false;
      m.layers.set(1);
      m.userData = { t: 0, dur: 1, size: 10, alpha: 1 };
      scene.add(m);
      this.rings.push(m);
    }

    this.fires = []; // continuous emitters
    this.flares = [];
    this.trauma = 0;
  }

  configure(quality, fog, light) {
    this.add.setMax(quality.particles);
    this.alpha.setMax(quality.particles);
    this.glow.setMax(Math.floor(quality.particles / 3));
    this.fogDensity = fog.density;
    for (const sys of [this.add, this.alpha, this.glow]) {
      sys.uniforms.uFogDensity.value = fog.density;
      sys.uniforms.uFogColor.value.copy(fog.color);
    }
    this.alpha.uniforms.uLight.value.copy(light);
    this.tracers.uniforms.uFogDensity.value = fog.density;
  }

  setScale(height, fov) {
    const s = height / (2 * Math.tan((fov * Math.PI) / 360));
    this.add.uniforms.uScale.value = s;
    this.alpha.uniforms.uScale.value = s;
    this.glow.uniforms.uScale.value = s;
  }

  get audio() {
    return this.game.audio;
  }

  // ---------------------------------------------------------------- primitives

  spark(x, y, z, speed, count, life = 0.8, size = 0.25) {
    for (let i = 0; i < count; i++) {
      _v.set(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize().multiplyScalar(speed * rand(0.4, 1));
      P.x = x;
      P.y = y;
      P.z = z;
      P.vx = _v.x;
      P.vy = _v.y;
      P.vz = _v.z;
      P.life = life * rand(0.5, 1.2);
      P.size0 = size;
      P.size1 = size * 0.4;
      P.color0 = SPARK;
      P.color1 = [2, 0.5, 0.1];
      P.alpha0 = 1;
      P.alpha1 = 0;
      P.drag = 0.8;
      P.gravity = 9.8;
      P.rotSpeed = 0;
      P.frame = 0;
      P.fadeIn = 0;
      this.glow.spawn(P);
    }
  }

  flash(x, y, z, size, color = [9, 6, 3.5], life = 0.12) {
    P.x = x;
    P.y = y;
    P.z = z;
    P.vx = P.vy = P.vz = 0;
    P.life = life;
    P.size0 = size;
    P.size1 = size * 1.3;
    P.color0 = color;
    P.color1 = color;
    P.alpha0 = 1;
    P.alpha1 = 0;
    P.drag = 0;
    P.gravity = 0;
    P.rotSpeed = 0;
    P.frame = 0;
    P.fadeIn = 0;
    this.glow.spawn(P);
  }

  puff(sys, x, y, z, vx, vy, vz, life, s0, s1, c0, c1, a0, drag, gravity, fadeIn = 0.08) {
    P.x = x;
    P.y = y;
    P.z = z;
    P.vx = vx;
    P.vy = vy;
    P.vz = vz;
    P.life = life;
    P.size0 = s0;
    P.size1 = s1;
    P.color0 = c0;
    P.color1 = c1;
    P.alpha0 = a0;
    P.alpha1 = 0;
    P.drag = drag;
    P.gravity = gravity;
    P.rot = undefined;
    P.rotSpeed = rand(-0.6, 0.6);
    P.frame = undefined;
    P.fadeIn = fadeIn;
    sys.spawn(P);
  }

  light(x, y, z, intensity, range, dur, color = 0xffa04a) {
    let best = this.lights[0];
    for (const l of this.lights) {
      if (l.userData.t >= l.userData.dur) {
        best = l;
        break;
      }
      if (l.intensity < best.intensity) best = l;
    }
    best.position.set(x, y, z);
    best.distance = range;
    best.color.setHex(color);
    best.userData.t = 0;
    best.userData.dur = dur;
    best.userData.peak = intensity;
    best.intensity = intensity;
  }

  ring(x, y, z, size, dur, color = 0xffd9a0, alpha = 0.9) {
    const r = this.rings.find((m) => !m.visible) || this.rings[0];
    r.visible = true;
    r.position.set(x, y, z);
    r.userData.t = 0;
    r.userData.dur = dur;
    r.userData.size = size;
    r.userData.alpha = alpha;
    r.material.color.setHex(color);
    r.scale.setScalar(0.1);
  }

  scorch(x, z, size) {
    const y = heightAt(x, z);
    if (y < 0.1) return;
    normalAt(x, z, _n);
    _q.setFromUnitVectors(_up, _n);
    _q.multiply(_spin.setFromAxisAngle(_up, Math.random() * 6.28));
    _s.set(size, 1, size);
    _v.set(x, y + 0.03, z);
    _m.compose(_v, _q, _s);
    const i = this.decalNext;
    this.decalNext = (this.decalNext + 1) % this.decalMax;
    this.decals.setMatrixAt(i, _m);
    this.decals.count = Math.max(this.decals.count, i + 1);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  spawnDebris(x, y, z, count, speed, charred = true) {
    for (let i = 0; i < count; i++) {
      if (this.debrisData.length >= this.debrisMax) this.debrisData.shift();
      _v.set(rand(-1, 1), rand(0.4, 1.4), rand(-1, 1)).normalize().multiplyScalar(speed * rand(0.4, 1));
      this.debrisData.push({
        x,
        y,
        z,
        vx: _v.x,
        vy: _v.y,
        vz: _v.z,
        rx: rand(0, 6),
        ry: rand(0, 6),
        wx: rand(-8, 8),
        wy: rand(-8, 8),
        s: rand(0.5, 1.8) * (charred ? 1 : 0.6),
        t: 0,
        life: rand(4, 7),
        rest: false,
        smoke: Math.random() < 0.3,
      });
    }
  }

  addTrauma(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Screen shake based on distance to the camera. */
  shakeFrom(x, y, z, strength, radius) {
    const cam = this.game.camera.position;
    const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
    if (d < radius) this.addTrauma(strength * (1 - d / radius) ** 1.5);
  }

  // ---------------------------------------------------------------- composite effects

  explosion(x, y, z, size = 'M', { air = false, water = null, sound = true } = {}) {
    const cfg = SIZES[size];
    const ground = heightAt(x, z);
    const inWater = water ?? (ground < 0 && y < 1.5);
    const onGround = !air && !inWater && y - ground < 2.5;
    const k = size === 'L' ? 1.6 : size === 'M' ? 1 : 0.55;

    this.flash(x, y + 0.5, z, cfg.fireSize[1] * 2.6, [10, 7, 4], 0.14);
    this.light(x, y + 2, z, cfg.light, cfg.lightR, size === 'L' ? 0.55 : 0.3);

    if (inWater) {
      this.waterColumn(x, z, size);
    } else {
      for (let i = 0; i < cfg.fire; i++) {
        _v.set(rand(-1, 1), rand(air ? -1 : 0, 1), rand(-1, 1)).normalize().multiplyScalar(rand(2, 9) * k);
        this.puff(
          this.add,
          x + _v.x * 0.2,
          y + _v.y * 0.2 + (air ? 0 : 0.5),
          z + _v.z * 0.2,
          _v.x,
          _v.y + (air ? 0 : 2),
          _v.z,
          rand(0.45, 0.95) * (size === 'L' ? 1.3 : 1),
          rand(cfg.fireSize[0], cfg.fireSize[1]) * 0.5,
          rand(cfg.fireSize[0], cfg.fireSize[1]),
          FIRE0,
          FIRE1,
          1,
          2.5,
          -3,
          0.02,
        );
      }
      for (let i = 0; i < cfg.smoke; i++) {
        _v.set(rand(-1, 1), rand(0.2, 1), rand(-1, 1)).normalize().multiplyScalar(rand(1, 5) * k);
        const dark = Math.random();
        this.puff(
          this.alpha,
          x + _v.x * 0.5,
          y + rand(0.2, 2) * k,
          z + _v.z * 0.5,
          _v.x,
          _v.y + rand(1.5, 4) * k,
          _v.z,
          rand(3, 7) * (size === 'L' ? 1.4 : 1),
          rand(cfg.smokeSize[0], cfg.smokeSize[1]) * 0.35,
          rand(cfg.smokeSize[0], cfg.smokeSize[1]),
          dark < 0.6 ? SMOKE_DARK : SMOKE_MID,
          SMOKE_MID,
          air ? 0.6 : 0.85,
          1.1,
          -0.5,
          0.12,
        );
      }
      if (onGround) {
        // sand thrown up
        const n = Math.round(cfg.smoke * 0.8);
        for (let i = 0; i < n; i++) {
          _v.set(rand(-1, 1), rand(1.2, 3.5), rand(-1, 1)).normalize().multiplyScalar(rand(6, 20) * k);
          this.puff(this.alpha, x, ground + 0.5, z, _v.x, _v.y, _v.z, rand(1.2, 2.6), rand(1, 2.5) * k, rand(4, 9) * k, SAND, SAND, 0.9, 1.6, 7, 0.05);
        }
        this.puff(this.alpha, x, ground + 1, z, 0, 1, 0, 4, 5 * k, 22 * k, SAND, SAND, 0.55, 0.4, -0.2, 0.1);
        this.scorch(x, z, cfg.scorch * rand(0.8, 1.2));
        if (size !== 'S') this.ring(x, ground + 0.3, z, cfg.fireSize[1] * 4, 0.45, 0xffe0b0, 0.6);
      }
    }
    if (cfg.sparks) this.spark(x, y + 0.5, z, 26 * k, cfg.sparks, 1.1, 0.3 * k + 0.1);
    if (cfg.debris && !inWater) this.spawnDebris(x, y + 0.5, z, cfg.debris, 16 * k, true);
    this.shakeFrom(x, y, z, cfg.shake, cfg.radius);
    if (sound && this.audio) {
      this.audio.play(cfg.sound, { position: _v.set(x, y, z) });
      if (inWater) this.audio.play('splashBig', { position: _v.set(x, 0, z) });
      if (cfg.debris && !inWater) this.audio.play('debris', { position: _v.set(x, y, z), delay: 0.25 });
    }
  }

  waterColumn(x, z, size = 'M') {
    const k = size === 'L' ? 1.7 : size === 'M' ? 1 : size === 'S' ? 0.5 : 0.15;
    const n = Math.round(24 * Math.max(k, 0.3));
    for (let i = 0; i < n; i++) {
      const up = rand(10, 26) * Math.sqrt(k);
      this.puff(this.alpha, x + rand(-1, 1) * k, 0.3, z + rand(-1, 1) * k, rand(-2, 2) * k, up, rand(-2, 2) * k, rand(1.4, 2.6) * Math.sqrt(k), rand(1, 2.5) * k, rand(3, 7) * k, WATER, WATER, 0.95, 0.4, 9.8, 0.02);
    }
    for (let i = 0; i < n / 2; i++) {
      _v.set(rand(-1, 1), 0, rand(-1, 1)).normalize().multiplyScalar(rand(3, 8) * k);
      this.puff(this.alpha, x, 0.4, z, _v.x, rand(1, 3), _v.z, rand(1.5, 3), 2 * k, 8 * k, WATER, WATER, 0.6, 1.2, 1, 0.05);
    }
    this.ring(x, 0.08, z, 30 * k, 2.2, 0xdfe8ee, 0.55);
  }

  splash(x, z, small = true) {
    if (small) {
      for (let i = 0; i < 4; i++) {
        this.puff(this.alpha, x, 0.1, z, rand(-0.6, 0.6), rand(4, 8), rand(-0.6, 0.6), rand(0.5, 0.9), 0.3, 1.2, WATER, WATER, 0.9, 0.5, 9.8, 0.02);
      }
    } else {
      this.waterColumn(x, z, 'S');
    }
  }

  sandHit(x, y, z, strong = false) {
    const k = strong ? 2 : 1;
    this.puff(this.alpha, x, y + 0.2, z, rand(-0.5, 0.5), rand(1.5, 3), rand(-0.5, 0.5), rand(0.8, 1.5), 0.4 * k, 1.8 * k, SAND, SAND, 0.85, 2, 1.5, 0.02);
    for (let i = 0; i < 3 * k; i++) {
      this.puff(this.alpha, x, y + 0.1, z, rand(-1.5, 1.5), rand(3, 7), rand(-1.5, 1.5), rand(0.5, 0.9), 0.18, 0.28, SAND_DARK, SAND_DARK, 1, 0.5, 14, 0);
    }
  }

  metalHit(x, y, z) {
    this.flash(x, y, z, 1.2, [8, 6, 3], 0.06);
    this.spark(x, y, z, 12, 5, 0.45, 0.14);
  }

  bloodHit(x, y, z) {
    for (let i = 0; i < 3; i++) {
      this.puff(this.alpha, x, y, z, rand(-1, 1), rand(0, 1.5), rand(-1, 1), rand(0.3, 0.5), 0.2, 0.7, [0.35, 0.03, 0.02], [0.25, 0.02, 0.02], 0.8, 3, 4, 0);
    }
  }

  /** One puff of a smoke trail (missiles, rockets, burning aircraft). */
  trail(x, y, z, kind = 'missile') {
    if (kind === 'missile' || kind === 'rocket') {
      this.puff(this.alpha, x, y, z, rand(-0.3, 0.3), rand(0.1, 0.6), rand(-0.3, 0.3), kind === 'missile' ? rand(1.8, 2.6) : 1.4, 0.5, 2.8, [0.75, 0.74, 0.72], [0.55, 0.55, 0.55], 0.65, 0.8, -0.2, 0.05);
      this.puff(this.add, x, y, z, 0, 0, 0, 0.08, 0.9, 0.4, FIRE0, FIRE1, 1, 0, 0, 0);
    } else if (kind === 'burning') {
      this.puff(this.alpha, x, y, z, rand(-0.5, 0.5), rand(0.5, 1.5), rand(-0.5, 0.5), rand(2.5, 4), 2, 7, SMOKE_DARK, SMOKE_MID, 0.8, 0.8, -0.6, 0.05);
      if (Math.random() < 0.6) this.puff(this.add, x, y, z, 0, 0.5, 0, 0.35, 1.5, 3, FIRE0, FIRE1, 0.9, 0, -1, 0);
    } else if (kind === 'damaged') {
      this.puff(this.alpha, x, y, z, rand(-0.3, 0.3), rand(0.3, 0.8), rand(-0.3, 0.3), rand(2, 3), 1.2, 4.5, SMOKE_DARK, SMOKE_MID, 0.55, 0.8, -0.4, 0.05);
    } else if (kind === 'wake') {
      this.puff(this.alpha, x, 0.25, z, rand(-0.6, 0.6), rand(0.2, 0.6), rand(-0.6, 0.6), rand(1.5, 2.5), 1.2, 4, WATER, WATER, 0.5, 0.8, 0.3, 0.1);
    } else if (kind === 'dust') {
      this.puff(this.alpha, x, y, z, rand(-0.6, 0.6), rand(0.4, 1.2), rand(-0.6, 0.6), rand(1.5, 2.8), 1, 4.5, SAND, SAND, 0.45, 0.8, -0.1, 0.1);
    } else if (kind === 'afterburner') {
      this.puff(this.add, x, y, z, 0, 0, 0, 0.12, 1.4, 0.6, [6, 3.2, 1.4], [1, 0.3, 0.1], 0.9, 0, 0, 0);
    }
  }

  /** Small muzzle flash in the world (enemy guns). */
  muzzle(x, y, z, size = 1.2) {
    this.flash(x, y, z, size * 2.2, [9, 6.5, 3], 0.07);
    if (size > 2) {
      this.puff(this.alpha, x, y, z, 0, 1, 0, 1.6, size, size * 4, SMOKE_MID, SMOKE_MID, 0.5, 1.2, -0.4, 0.05);
    }
  }

  /** Continuous fire + smoke column on a wreck. `target` is an Object3D or a Vector3. */
  addFire(target, offset, { duration = 40, size = 1, smokeOnly = false } = {}) {
    if (this.fires.length >= 12) this.fires.shift();
    const f = { target, offset: offset.clone(), t: 0, duration, size, acc: 0, smokeOnly };
    this.fires.push(f);
    return f;
  }

  removeFire(f) {
    const i = this.fires.indexOf(f);
    if (i >= 0) this.fires.splice(i, 1);
  }

  /** Night illumination flare that drifts down under a parachute. */
  dropFlare(x, y, z) {
    this.flares.push({ x, y, z, t: 0, dur: 26 });
  }

  clear() {
    this.add.clear();
    this.alpha.clear();
    this.glow.clear();
    this.fires.length = 0;
    this.flares.length = 0;
    this.debrisData.length = 0;
    this.debris.count = 0;
    this.decals.count = 0;
    this.decalNext = 0;
    for (const l of this.lights) {
      l.intensity = 0;
      l.userData.t = l.userData.dur = 0;
    }
    this.flareLight.intensity = 0;
    for (const r of this.rings) r.visible = false;
    this.trauma = 0;
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    // Continuous emitters.
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t += dt;
      if (f.t > f.duration) {
        this.fires.splice(i, 1);
        continue;
      }
      const life = 1 - f.t / f.duration;
      f.acc += dt * (f.smokeOnly ? 4 : 9) * Math.max(0.3, life);
      if (f.target.isObject3D) {
        _v.copy(f.offset);
        f.target.localToWorld(_v);
      } else _v.copy(f.target).add(f.offset);
      while (f.acc >= 1) {
        f.acc -= 1;
        const s = f.size;
        if (!f.smokeOnly && life > 0.3) {
          this.puff(this.add, _v.x + rand(-0.8, 0.8) * s, _v.y + rand(0, 0.5), _v.z + rand(-0.8, 0.8) * s, 0, rand(1.5, 3), 0, rand(0.4, 0.8), 1.2 * s, 2.8 * s, FIRE0, FIRE1, 1, 0.5, -1.5, 0.05);
        }
        this.puff(this.alpha, _v.x + rand(-0.6, 0.6) * s, _v.y + 1.2 * s, _v.z + rand(-0.6, 0.6) * s, rand(0.6, 1.4), rand(2.5, 4.5), rand(-0.3, 0.3), rand(5, 9), 2 * s, 9 * s, SMOKE_DARK, SMOKE_MID, 0.75 * Math.min(1, life * 2), 0.5, -0.3, 0.1);
      }
    }

    this.add.update(dt);
    this.alpha.update(dt);
    this.glow.update(dt);

    // Lights.
    for (const l of this.lights) {
      const u = l.userData;
      if (u.t < u.dur) {
        u.t += dt;
        const k = Math.max(0, 1 - u.t / u.dur);
        l.intensity = u.peak * k * k * (0.85 + Math.random() * 0.3);
      } else if (l.intensity !== 0) l.intensity = 0;
    }

    // Flares.
    let flareI = 0;
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.t += dt;
      f.y -= dt * 4;
      f.x += dt * 1.2;
      if (f.t > f.dur || f.y < heightAt(f.x, f.z) + 2) {
        this.flares.splice(i, 1);
        continue;
      }
      const k = Math.min(1, f.t / 1.5) * Math.min(1, (f.dur - f.t) / 3);
      if (flareI === 0) {
        this.flareLight.position.set(f.x, f.y, f.z);
        flareI = k * (2.2e5 + Math.random() * 3e4);
      }
      this.flash(f.x, f.y, f.z, 6 * k + 1, [12, 11, 8], 0.05);
      if (Math.random() < dt * 8) this.puff(this.alpha, f.x, f.y + 0.5, f.z, 0.5, 0.6, 0, 5, 1, 4, SMOKE_MID, SMOKE_MID, 0.35, 0.3, -0.2, 0.1);
    }
    this.flareLight.intensity = flareI;

    // Rings.
    for (const r of this.rings) {
      if (!r.visible) continue;
      const u = r.userData;
      u.t += dt;
      const t = u.t / u.dur;
      if (t >= 1) {
        r.visible = false;
        continue;
      }
      r.scale.setScalar(0.1 + u.size * (1 - (1 - t) ** 3));
      r.material.opacity = u.alpha * (1 - t);
    }

    // Debris physics.
    const d = this.debrisData;
    for (let i = d.length - 1; i >= 0; i--) {
      const p = d[i];
      p.t += dt;
      if (p.t > p.life) {
        d.splice(i, 1);
        continue;
      }
      if (!p.rest) {
        p.vy -= 9.8 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.rx += p.wx * dt;
        p.ry += p.wy * dt;
        const floor = heightAt(p.x, p.z);
        if (floor < 0 && p.y < 0) {
          d.splice(i, 1);
          if (Math.random() < 0.5) this.splash(p.x, p.z, true);
          continue;
        }
        if (p.y < floor + 0.1) {
          p.y = floor + 0.1;
          if (Math.abs(p.vy) < 2.5) {
            p.rest = true;
          } else {
            p.vy *= -0.3;
            p.vx *= 0.5;
            p.vz *= 0.5;
            if (Math.random() < 0.4) this.sandHit(p.x, p.y, p.z);
          }
        }
        if (p.smoke && Math.random() < dt * 20) this.trail(p.x, p.y, p.z, 'damaged');
      }
    }
    this.debris.count = d.length;
    for (let i = 0; i < d.length; i++) {
      const p = d[i];
      const fade = p.life - p.t < 1 ? p.life - p.t : 1;
      _v.set(p.x, p.y, p.z);
      _q.setFromEuler(_euler.set(p.rx, p.ry, 0));
      _s.setScalar(p.s * fade);
      _m.compose(_v, _q, _s);
      this.debris.setMatrixAt(i, _m);
    }
    if (d.length) this.debris.instanceMatrix.needsUpdate = true;

    this.trauma = Math.max(0, this.trauma - dt * 1.1);
  }
}
