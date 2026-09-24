import * as THREE from 'three';
import {
  buildViewTwinMG,
  buildViewATGun,
  buildViewMissilePod,
  buildViewPistol,
  buildViewHowitzer,
} from '../entities/models/index.js';
import { makeFlashTexture, makeFlashSideTexture } from '../fx/TextureFactory.js';
import { damp } from '../core/math.js';

// Camera-space placement of each first-person weapon (tuned by eye).
export const VIEW_POSE = {
  mg: { pos: [0, -0.5, -0.12], rot: [0.02, 0, 0] },
  at: { pos: [0, -0.52, -0.1], rot: [0.02, 0, 0] },
  missile: { pos: [0, -0.5, -0.25], rot: [0.02, 0, 0] },
  pistol: { pos: [0.3, -0.34, -0.62], rot: [0, 0, 0] },
  howitzer: { pos: [0, -0.62, -0.1], rot: [0.02, 0, 0] },
};

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

function flashMesh(scale = 1) {
  const g = new THREE.Group();
  const star = new THREE.Mesh(
    new THREE.PlaneGeometry(0.55 * scale, 0.55 * scale),
    new THREE.MeshBasicMaterial({
      map: makeFlashTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: new THREE.Color(3.5, 2.8, 2),
      toneMapped: false,
    }),
  );
  g.add(star);
  const sideMat = new THREE.MeshBasicMaterial({
    map: makeFlashSideTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: new THREE.Color(3, 2.3, 1.6),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  for (let i = 0; i < 2; i++) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(0.9 * scale, 0.36 * scale), sideMat);
    side.geometry.translate(0.45 * scale, 0, 0);
    side.rotation.y = Math.PI / 2; // extends along -Z (out of the muzzle)
    side.rotation.x = (i * Math.PI) / 2;
    g.add(side);
  }
  g.visible = false;
  g.userData.t = 0;
  return g;
}

/** First-person gun models in their own overlay scene: recoil, sway, weapon switching, muzzle flashes. */
export class Viewmodels {
  constructor(game) {
    this.game = game;
    const scene = game.renderer.viewScene;
    this.scene = scene;
    this.camera = game.renderer.viewCamera;
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.position.set(0.4, 1, 0.3);
    this.hemi = new THREE.HemisphereLight(0xdde6ff, 0x6b5a43, 0.5);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 4, 2);
    this.flashLight.position.set(0, -0.2, -1.2);
    scene.add(this.sun, this.hemi, this.flashLight);

    const m = game.mats;
    this.models = {
      mg: buildViewTwinMG(m),
      at: buildViewATGun(m),
      missile: buildViewMissilePod(m),
      pistol: buildViewPistol(m),
      howitzer: buildViewHowitzer(m),
    };
    this.rig = new THREE.Group();
    scene.add(this.rig);
    for (const [name, model] of Object.entries(this.models)) {
      model.root.visible = false;
      model.root.traverse((o) => {
        if (o.isMesh) o.frustumCulled = false;
      });
      this.rig.add(model.root);
      model.base = VIEW_POSE[name];
    }
    const mg = this.models.mg;
    this.flashes = {
      mgL: this.attachFlash(mg.muzzleL, 1),
      mgR: this.attachFlash(mg.muzzleR, 1),
      at: this.attachFlash(this.models.at.muzzle, 2.2),
      missileL: this.attachFlash(this.models.missile.muzzleL, 1.6),
      missileR: this.attachFlash(this.models.missile.muzzleR, 1.6),
      pistol: this.attachFlash(this.models.pistol.muzzle, 0.5),
      howitzer: this.attachFlash(this.models.howitzer.muzzle, 3),
    };
    this.barrelBase = {
      mgL: mg.barrelL.position.z,
      mgR: mg.barrelR.position.z,
      at: this.models.at.barrel.position.z,
      how: this.models.howitzer.barrel.position.z,
      slide: this.models.pistol.slide.position.z,
    };
    this.recoil = { mgL: 0, mgR: 0, at: 0, how: 0, slide: 0, root: 0 };
    this.current = 'mg';
    this.target = 'mg';
    this.switchT = 1; // 0..1 lower, 1..2 raise
    this.swayX = 0;
    this.swayY = 0;
    this.bob = 0;
    this.pistolSwing = 0;
    this.reloadDip = 0;
    this.setWeapon('mg', true);
  }

  attachFlash(socket, scale) {
    const f = flashMesh(scale);
    socket.add(f);
    return f;
  }

  setWeapon(name, immediate = false) {
    this.target = name;
    if (immediate) {
      this.current = name;
      this.switchT = 2;
      this.applyVisibility();
    } else if (this.switchT >= 1) {
      this.switchT = 0;
    }
  }

  get switching() {
    return this.switchT < 2 && this.target !== this.current ? true : this.switchT < 2;
  }

  applyVisibility() {
    const cur = this.current;
    for (const [name, model] of Object.entries(this.models)) model.root.visible = name === cur;
    // The handgun replaces the right barrel of the AA gun: show both.
    if (cur === 'pistol') this.models.mg.root.visible = true;
  }

  muzzleFlash(key, dur = 0.05) {
    const f = this.flashes[key];
    if (!f) return;
    f.visible = true;
    f.userData.t = dur;
    f.rotation.z = Math.random() * Math.PI;
    const s = 0.8 + Math.random() * 0.5;
    f.scale.setScalar(s);
    this.flashLight.intensity = key === 'at' || key === 'howitzer' ? 40 : 14;
  }

  kick(kind, which) {
    const r = this.recoil;
    if (kind === 'mg') {
      r[which === 0 ? 'mgL' : 'mgR'] = 1;
      r.root = Math.min(1, r.root + 0.25);
      this.muzzleFlash(which === 0 ? 'mgL' : 'mgR');
    } else if (kind === 'at') {
      r.at = 1;
      r.root = 1;
      this.muzzleFlash('at', 0.08);
    } else if (kind === 'howitzer') {
      r.how = 1;
      r.root = 1;
      this.muzzleFlash('howitzer', 0.1);
    } else if (kind === 'missile') {
      r.root = 0.5;
      this.muzzleFlash(which === 0 ? 'missileL' : 'missileR', 0.12);
      const m = this.models.missile;
      (which === 0 ? m.missileL : m.missileR).visible = false;
    } else if (kind === 'pistol') {
      r.slide = 1;
      r.root = 0.4;
      this.muzzleFlash('pistol', 0.04);
    }
  }

  reloadMissile(which) {
    const m = this.models.missile;
    (which === 0 ? m.missileL : m.missileR).visible = true;
  }

  /** World-space point that appears at the muzzle on screen (tracers start here). */
  muzzleWorld(key, out) {
    const f = this.flashes[key] || this.flashes.mgL;
    f.parent.getWorldPosition(_v);
    _v.project(this.camera);
    const cam = this.game.camera;
    out.set(_v.x, _v.y, 0.5).unproject(cam);
    out.sub(cam.position).normalize().multiplyScalar(2.2).add(cam.position);
    return out;
  }

  update(dt, lookDX, lookDY) {
    const game = this.game;
    // weapon switch: lower the old weapon, raise the new one
    if (this.switchT < 2) {
      this.switchT += dt / 0.22;
      if (this.switchT >= 1 && this.current !== this.target) {
        this.current = this.target;
        this.applyVisibility();
      }
      if (this.switchT > 2) this.switchT = 2;
    }
    const lower = this.switchT < 1 ? this.switchT : 2 - this.switchT;

    // sway follows mouse movement a little
    this.swayX = damp(this.swayX, Math.max(-1, Math.min(1, -lookDX * 0.004)), 8, dt);
    this.swayY = damp(this.swayY, Math.max(-1, Math.min(1, lookDY * 0.004)), 8, dt);
    this.bob += dt;

    const r = this.recoil;
    for (const k of Object.keys(r)) r[k] = Math.max(0, r[k] - dt * (k === 'at' || k === 'how' ? 2.2 : k === 'root' ? 6 : 16));
    this.reloadDip = damp(this.reloadDip, game.weapons.reloading ? 1 : 0, 10, dt);

    const cur = this.current;
    const model = this.models[cur];
    const pose = VIEW_POSE[cur];
    const kickZ = r.root * (cur === 'at' || cur === 'howitzer' ? 0.12 : 0.02);
    const kickX = r.root * (cur === 'at' || cur === 'howitzer' ? 0.05 : 0.01);
    model.root.position.set(
      pose.pos[0] + this.swayX * 0.03 + (Math.random() - 0.5) * r.root * 0.006,
      pose.pos[1] - lower * 0.6 + this.swayY * 0.02 + Math.sin(this.bob * 1.3) * 0.003 - this.reloadDip * 0.12,
      pose.pos[2] + kickZ,
    );
    model.root.rotation.set(pose.rot[0] + kickX - lower * 0.4 - this.reloadDip * 0.35, pose.rot[1] + this.swayX * 0.03, pose.rot[2]);

    const mg = this.models.mg;
    mg.barrelL.position.z = this.barrelBase.mgL + r.mgL * 0.07;
    mg.barrelR.position.z = this.barrelBase.mgR + r.mgR * 0.07;
    this.models.at.barrel.position.z = this.barrelBase.at + r.at * 0.45;
    this.models.howitzer.barrel.position.z = this.barrelBase.how + r.how * 0.6;
    this.models.pistol.slide.position.z = this.barrelBase.slide + r.slide * 0.04;

    // pistol mode: the right MG swings out of the way
    this.pistolSwing = damp(this.pistolSwing, cur === 'pistol' ? 1 : 0, 10, dt);
    mg.barrelR.rotation.y = -this.pistolSwing * 0.9;
    mg.barrelR.position.x = (mg.barrelR.userData.baseX ??= mg.barrelR.position.x) + this.pistolSwing * 0.35;
    if (cur === 'pistol') {
      mg.root.position.set(VIEW_POSE.mg.pos[0], VIEW_POSE.mg.pos[1] - 0.05, VIEW_POSE.mg.pos[2]);
      mg.root.rotation.set(VIEW_POSE.mg.rot[0], 0, 0);
    }

    for (const f of Object.values(this.flashes)) {
      if (!f.visible) continue;
      f.userData.t -= dt;
      if (f.userData.t <= 0) f.visible = false;
    }
    this.flashLight.intensity = damp(this.flashLight.intensity, 0, 30, dt);

    // lighting follows the world sun relative to the camera
    const cam = game.camera;
    _q.copy(cam.quaternion).invert();
    const sky = game.world.sky;
    this.sun.position.copy(sky.sunDir).applyQuaternion(_q);
    this.sun.intensity = sky.sun.intensity * 0.85;
    this.sun.color.copy(sky.sun.color);
    this.hemi.intensity = sky.hemi.intensity * 1.6 + 0.15;
    this.scene.environment = game.scene.environment;
    this.scene.environmentRotation.set(0, (sky.rotation || 0) - cam.rotation.y, 0);
    this.scene.environmentIntensity = sky.preset === undefined ? 1 : game.scene.environmentIntensity;
  }
}
