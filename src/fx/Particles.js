import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  attribute float aRot;
  attribute float aFrame;
  uniform float uScale;
  uniform float uFogDensity;
  varying vec4 vColor;
  varying float vRot;
  varying float vFrame;
  varying float vFog;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float d = max(0.1, -mv.z);
    gl_PointSize = min(aSize * uScale / d, 2048.0);
    vColor = aColor;
    vRot = aRot;
    vFrame = aFrame;
    vFog = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uFogColor;
  uniform vec3 uLight;
  uniform float uAdditive;
  uniform float uAtlas;
  varying vec4 vColor;
  varying float vRot;
  varying float vFrame;
  varying float vFog;
  void main() {
    vec2 pc = gl_PointCoord - 0.5;
    if (dot(pc, pc) > 0.25) discard;
    float c = cos(vRot);
    float s = sin(vRot);
    vec2 p = vec2(c * pc.x - s * pc.y, s * pc.x + c * pc.y) * 0.98 + 0.5;
    if (uAtlas > 0.5) {
      float f = floor(vFrame + 0.5);
      p = (clamp(p, 0.01, 0.99) + vec2(mod(f, 2.0), floor(f / 2.0))) * 0.5;
    }
    vec4 t = texture2D(uMap, p);
    float a = vColor.a * t.a;
    if (a < 0.004) discard;
    if (uAdditive > 0.5) {
      gl_FragColor = vec4(vColor.rgb * t.rgb * (1.0 - vFog), a);
    } else {
      vec3 col = vColor.rgb * t.rgb * uLight;
      gl_FragColor = vec4(mix(col, uFogColor, vFog), a);
    }
  }
`;

/**
 * CPU-simulated point sprites. Two instances are used: additive (fire, flashes, sparks) and
 * alpha-blended (smoke, dust, spray).
 */
export class ParticleSystem {
  constructor(max, texture, { additive = false, atlas = false } = {}) {
    this.max = max;
    this.count = 0;
    const n = max;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.col0 = new Float32Array(n * 4);
    this.col1 = new Float32Array(n * 4);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.rotSpeed = new Float32Array(n);
    this.frame = new Float32Array(n);
    this.fadeIn = new Float32Array(n);

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    this.aFrame = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aRot', this.aRot);
    geo.setAttribute('aFrame', this.aFrame);
    geo.setDrawRange(0, 0);

    this.uniforms = {
      uMap: { value: texture },
      uScale: { value: 800 },
      uFogDensity: { value: 0.0005 },
      uFogColor: { value: new THREE.Color() },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uAdditive: { value: additive ? 1 : 0 },
      uAtlas: { value: atlas ? 1 : 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.layers.set(1);
    this.points.renderOrder = additive ? 11 : 10;
  }

  setMax(max) {
    this.limit = Math.min(max, this.max);
  }

  /** Spawns one particle from a parameter object (see Effects for usage). Returns false if full. */
  spawn(p) {
    const limit = this.limit || this.max;
    let i;
    if (this.count < limit) {
      i = this.count++;
    } else {
      // replace a random old particle so big explosions never lose their core
      i = Math.floor(Math.random() * this.count);
    }
    const i3 = i * 3;
    const i4 = i * 4;
    this.pos[i3] = p.x;
    this.pos[i3 + 1] = p.y;
    this.pos[i3 + 2] = p.z;
    this.vel[i3] = p.vx || 0;
    this.vel[i3 + 1] = p.vy || 0;
    this.vel[i3 + 2] = p.vz || 0;
    this.life[i] = 0;
    this.maxLife[i] = p.life;
    this.size0[i] = p.size0;
    this.size1[i] = p.size1 ?? p.size0;
    const c0 = p.color0;
    const c1 = p.color1 || c0;
    this.col0[i4] = c0[0];
    this.col0[i4 + 1] = c0[1];
    this.col0[i4 + 2] = c0[2];
    this.col0[i4 + 3] = p.alpha0 ?? 1;
    this.col1[i4] = c1[0];
    this.col1[i4 + 1] = c1[1];
    this.col1[i4 + 2] = c1[2];
    this.col1[i4 + 3] = p.alpha1 ?? 0;
    this.drag[i] = p.drag || 0;
    this.grav[i] = p.gravity || 0;
    this.rot[i] = p.rot ?? Math.random() * 6.283;
    this.rotSpeed[i] = p.rotSpeed || 0;
    this.frame[i] = p.frame ?? Math.floor(Math.random() * 4);
    this.fadeIn[i] = p.fadeIn || 0;
    return true;
  }

  update(dt) {
    let n = this.count;
    const pos = this.pos;
    const vel = this.vel;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        n--;
        if (i !== n) this.copy(n, i);
        i--;
        continue;
      }
      const i3 = i * 3;
      const drag = Math.exp(-this.drag[i] * dt);
      vel[i3] *= drag;
      vel[i3 + 1] = vel[i3 + 1] * drag - this.grav[i] * dt;
      vel[i3 + 2] *= drag;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      this.rot[i] += this.rotSpeed[i] * dt;
    }
    this.count = n;

    const aPos = this.aPos.array;
    const aSize = this.aSize.array;
    const aCol = this.aColor.array;
    const aRot = this.aRot.array;
    const aFrame = this.aFrame.array;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const i4 = i * 4;
      const t = this.life[i] / this.maxLife[i];
      const e = 1 - (1 - t) * (1 - t); // ease-out growth
      aPos[i3] = pos[i3];
      aPos[i3 + 1] = pos[i3 + 1];
      aPos[i3 + 2] = pos[i3 + 2];
      aSize[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * e;
      aCol[i4] = this.col0[i4] + (this.col1[i4] - this.col0[i4]) * t;
      aCol[i4 + 1] = this.col0[i4 + 1] + (this.col1[i4 + 1] - this.col0[i4 + 1]) * t;
      aCol[i4 + 2] = this.col0[i4 + 2] + (this.col1[i4 + 2] - this.col0[i4 + 2]) * t;
      let a = this.col0[i4 + 3] + (this.col1[i4 + 3] - this.col0[i4 + 3]) * t;
      const fi = this.fadeIn[i];
      if (fi > 0 && t < fi) a *= t / fi;
      aCol[i4 + 3] = a;
      aRot[i] = this.rot[i];
      aFrame[i] = this.frame[i];
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, n);
    if (n > 0) {
      this.aPos.addUpdateRange(0, n * 3);
      this.aSize.addUpdateRange(0, n);
      this.aColor.addUpdateRange(0, n * 4);
      this.aRot.addUpdateRange(0, n);
      this.aFrame.addUpdateRange(0, n);
      this.aPos.needsUpdate = true;
      this.aSize.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aRot.needsUpdate = true;
      this.aFrame.needsUpdate = true;
    }
  }

  copy(from, to) {
    const f3 = from * 3;
    const t3 = to * 3;
    const f4 = from * 4;
    const t4 = to * 4;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
    }
    for (let k = 0; k < 4; k++) {
      this.col0[t4 + k] = this.col0[f4 + k];
      this.col1[t4 + k] = this.col1[f4 + k];
    }
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.size0[to] = this.size0[from];
    this.size1[to] = this.size1[from];
    this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from];
    this.rot[to] = this.rot[from];
    this.rotSpeed[to] = this.rotSpeed[from];
    this.frame[to] = this.frame[from];
    this.fadeIn[to] = this.fadeIn[from];
  }

  clear() {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
  }
}
