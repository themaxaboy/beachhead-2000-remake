import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';

/** The sea: reflective Water.js on medium/high quality, a cheap PBR plane on low. */
export class Ocean {
  constructor(assets, scene, mode) {
    this.assets = assets;
    this.scene = scene;
    this.normals = assets.textures.waterNormals;
    this.normals.wrapS = this.normals.wrapT = THREE.RepeatWrapping;
    this.mesh = null;
    this.setMode(mode);
  }

  setMode(mode) {
    if (this.mode === mode && this.mesh) return;
    this.mode = mode;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    const geo = new THREE.PlaneGeometry(24000, 24000);
    if (mode === 'simple') {
      const n = this.normals.clone();
      n.repeat.set(900, 900);
      this.mat = new THREE.MeshStandardMaterial({
        color: 0x1d4553,
        roughness: 0.08,
        metalness: 0.1,
        normalMap: n,
        normalScale: new THREE.Vector2(0.35, 0.35),
      });
      this.mesh = new THREE.Mesh(geo, this.mat);
      this.simpleNormals = n;
    } else {
      const size = typeof mode === 'number' ? mode : 512;
      this.mesh = new Water(geo, {
        textureWidth: size,
        textureHeight: size,
        waterNormals: this.normals,
        sunDirection: new THREE.Vector3(0.5, 0.5, 0),
        sunColor: 0xffffff,
        waterColor: 0x1b4a5a,
        distortionScale: 3.2,
        fog: true,
        alpha: 1,
      });
      this.mesh.material.uniforms.size.value = 1.6;
    }
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0;
    this.mesh.name = 'ocean';
    this.scene.add(this.mesh);
    if (this.lastSky) this.applySky(this.lastSky.sunDir, this.lastSky.sunColor, this.lastSky.water, this.lastSky.intensity);
  }

  applySky(sunDir, sunColor, waterColor, intensity) {
    this.lastSky = { sunDir: sunDir.clone(), sunColor: sunColor.clone(), water: waterColor, intensity };
    if (this.mesh.isWater) {
      const u = this.mesh.material.uniforms;
      u.sunDirection.value.copy(sunDir).normalize();
      u.sunColor.value.copy(sunColor).multiplyScalar(Math.min(1.6, intensity * 0.45));
      u.waterColor.value.setHex(waterColor);
    } else {
      this.mat.color.setHex(waterColor).multiplyScalar(1.1);
    }
  }

  update(dt) {
    if (this.mesh.isWater) {
      this.mesh.material.uniforms.time.value += dt * 0.55;
    } else if (this.simpleNormals) {
      this.simpleNormals.offset.x += dt * 0.004;
      this.simpleNormals.offset.y += dt * 0.0025;
    }
  }
}
