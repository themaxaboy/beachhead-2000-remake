import * as THREE from 'three';
import { heightAt, normalAt, shoreZ } from './Terrain.js';
import { hedgehogGeometry, sandbagGeometry, barbedWireGeometry } from '../entities/models/index.js';
import { Rng } from '../core/rng.js';
import { DEG } from '../core/math.js';
import { makeGrassTexture } from '../fx/TextureFactory.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();

function instanced(geo, mat, transforms, { castShadow = true, receiveShadow = true } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, transforms.length);
  transforms.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  mesh.computeBoundingSphere();
  return mesh;
}

function groundMatrix(x, z, yaw, scale = 1, sink = 0, alignToGround = 1) {
  const y = heightAt(x, z) - sink;
  normalAt(x, z, _n);
  _n.lerp(_up, 1 - alignToGround).normalize();
  _q.setFromUnitVectors(_up, _n);
  const qy = new THREE.Quaternion().setFromAxisAngle(_up, yaw);
  _q.multiply(qy);
  _s.setScalar(scale);
  _p.set(x, y, z);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** Static scenery: bunker, sandbags, beach obstacles, rocks, barrels, grass. */
export class Props {
  constructor(assets, mats, quality) {
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.obstacles = []; // circles ground vehicles steer around: {x, z, r}
    const rng = new Rng(4242);

    this.buildBunker(mats, rng);
    this.buildBeachDefences(mats, rng);
    this.buildScatter(assets, rng);
    this.grass = null;
    this.setGrass(quality.grass);
  }

  buildBunker(mats, rng) {
    const top = heightAt(0, 0);
    // Concrete turret ring the gun sits in.
    const ringShape = new THREE.Shape();
    ringShape.absarc(0, 0, 3.4, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, 2.6, 0, Math.PI * 2, true);
    ringShape.holes.push(hole);
    const ringGeo = new THREE.ExtrudeGeometry(ringShape, {
      depth: 1.7,
      bevelEnabled: true,
      bevelThickness: 0.12,
      bevelSize: 0.12,
      bevelSegments: 2,
      curveSegments: 48,
    });
    ringGeo.rotateX(-Math.PI / 2);
    const concrete = mats.concrete;
    const ring = new THREE.Mesh(ringGeo, concrete);
    ring.position.y = top - 0.4;
    ring.castShadow = ring.receiveShadow = true;
    this.group.add(ring);

    // Low bunker walls / embrasure blocks around the mound top.
    const block = new THREE.BoxGeometry(2.4, 1.2, 1.1);
    const blocks = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + 0.1;
      const r = 5.2;
      const x = Math.sin(a) * r;
      const z = -Math.cos(a) * r;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, top + 0.2, z),
        new THREE.Quaternion().setFromAxisAngle(_up, -a),
        new THREE.Vector3(1, rng.range(0.8, 1.1), 1),
      );
      blocks.push(m);
    }
    this.group.add(instanced(block, concrete, blocks));

    // Sandbag ring, three courses high.
    const bagGeo = sandbagGeometry();
    const bags = [];
    for (let course = 0; course < 3; course++) {
      const r = 7.4 - course * 0.12;
      const n = Math.floor((Math.PI * 2 * r) / 0.62);
      for (let i = 0; i < n; i++) {
        const a = ((i + (course % 2) * 0.5) / n) * Math.PI * 2;
        const x = Math.sin(a) * r;
        const z = -Math.cos(a) * r;
        _e.set(rng.range(-0.05, 0.05), -a + rng.range(-0.06, 0.06), rng.range(-0.04, 0.04));
        bags.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(x, heightAt(x, z) + 0.08 + course * 0.16, z),
            new THREE.Quaternion().setFromEuler(_e),
            new THREE.Vector3(rng.range(0.95, 1.05), 1, 1),
          ),
        );
      }
    }
    this.group.add(instanced(bagGeo, mats.sandbag, bags));
  }

  buildBeachDefences(mats, rng) {
    // Czech hedgehogs scattered across the upper beach.
    const hh = [];
    for (let i = 0; i < 44; i++) {
      const x = rng.range(-330, 330);
      const zc = shoreZ(x);
      const z = zc + rng.range(8, 55);
      if (Math.hypot(x, z) < 40) continue;
      hh.push(groundMatrix(x, z, rng.range(0, Math.PI * 2), rng.range(0.9, 1.15), 0.15, 0.3));
      this.obstacles.push({ x, z, r: 1.6 });
    }
    this.group.add(instanced(hedgehogGeometry(), mats.hedgehog, hh));

    // Barbed-wire concertina lines on two arcs in front of the bunker.
    const wireGeo = barbedWireGeometry(6);
    const wire = [];
    for (const radius of [34, 62]) {
      const seg = 6 / radius;
      for (let a = -78 * DEG; a < 78 * DEG; a += seg) {
        if (rng.chance(0.12)) continue; // gaps
        const x = Math.sin(a) * radius;
        const z = -Math.cos(a) * radius;
        wire.push(groundMatrix(x, z, -a, 1, 0.05, 0.6));
      }
    }
    this.group.add(instanced(wireGeo, mats.wire, wire, { castShadow: false }));
  }

  buildScatter(assets, rng) {
    const addClones = (src, count, place) => {
      if (!src) return;
      src.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      for (let i = 0; i < count; i++) {
        const t = place(i);
        if (!t) continue;
        const c = src.clone();
        c.position.set(t.x, heightAt(t.x, t.z) - (t.sink || 0), t.z);
        c.rotation.set(t.rx || 0, t.yaw || 0, t.rz || 0);
        c.scale.setScalar(t.scale || 1);
        this.group.add(c);
        if (t.r) this.obstacles.push({ x: t.x, z: t.z, r: t.r });
      }
    };

    addClones(assets.models.rock_07, 26, () => {
      const side = rng.sign();
      const x = side * rng.range(120, 420);
      const z = shoreZ(x) + rng.range(-6, 70);
      const s = rng.range(2.5, 6);
      return { x, z, yaw: rng.range(0, 6.28), scale: s, sink: s * 0.2, r: s * 0.6 };
    });
    addClones(assets.models.barrel_03, 12, (i) => {
      const a = rng.range(-2.6, 2.6) + Math.PI;
      const r = rng.range(12, 26);
      const x = Math.sin(a) * r;
      const z = -Math.cos(a) * r;
      const fallen = i % 4 === 0;
      return { x, z, yaw: rng.range(0, 6.28), rx: fallen ? Math.PI / 2 : 0, scale: 1.1, sink: fallen ? -0.3 : 0 };
    });
    addClones(assets.models.old_military_crate, 7, (i) => {
      const x = -5 + (i % 4) * 1.4 + rng.range(-0.1, 0.1);
      const z = 11 + Math.floor(i / 4) * 1.5;
      return { x, z, yaw: rng.range(-0.2, 0.2), scale: 1.6, sink: -0.02 };
    });
  }

  setGrass(count) {
    if (this.grass) {
      this.group.remove(this.grass);
      this.grass.geometry.dispose();
      this.grass = null;
    }
    if (!count) return;
    const rng = new Rng(99);
    // Two crossed quads per clump.
    const quad = new THREE.PlaneGeometry(1.4, 0.9);
    quad.translate(0, 0.45, 0);
    const quad2 = quad.clone().rotateY(Math.PI / 2);
    const geo = mergeTwo(quad, quad2);
    const mat = new THREE.MeshStandardMaterial({
      map: makeGrassTexture(),
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      roughness: 0.9,
      color: 0xc9c69a,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.grassTime = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = instanceMatrix[3].xyz;
          #else
            vec3 ip = vec3(0.0);
          #endif
          float sway = sin(uTime * 1.7 + ip.x * 0.21 + ip.z * 0.17) * 0.12 * position.y;
          transformed.x += sway;
          transformed.z += sway * 0.6;`,
        );
    };
    const mats = [];
    let tries = 0;
    while (mats.length < count && tries++ < count * 8) {
      const x = rng.range(-500, 500);
      const z = rng.range(-40, 420);
      const h = heightAt(x, z);
      if (h < 3.4 || Math.hypot(x, z) < 11) continue;
      if (z < shoreZ(x) + 70) continue;
      mats.push(groundMatrix(x, z, rng.range(0, 6.28), rng.range(0.7, 1.6), 0.05, 0.4));
    }
    this.grass = instanced(geo, mat, mats, { castShadow: false });
    this.group.add(this.grass);
  }

  update(dt) {
    if (this.grassTime) this.grassTime.value += dt;
  }
}

function mergeTwo(a, b) {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const A = a.attributes[name];
    const B = b.attributes[name];
    const arr = new Float32Array(A.array.length + B.array.length);
    arr.set(A.array, 0);
    arr.set(B.array, A.array.length);
    g.setAttribute(name, new THREE.BufferAttribute(arr, A.itemSize));
  }
  const ia = a.index.array;
  const ib = b.index.array;
  const idx = new Uint16Array(ia.length + ib.length);
  idx.set(ia, 0);
  const off = a.attributes.position.count;
  for (let i = 0; i < ib.length; i++) idx[ia.length + i] = ib[i] + off;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
