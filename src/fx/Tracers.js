import * as THREE from 'three';

/** Camera-facing glowing line segments for tracer rounds, rebuilt every frame. */
export class Tracers {
  constructor(max = 400) {
    this.max = max;
    this.n = 0;
    const base = new THREE.InstancedBufferGeometry();
    base.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3),
    );
    base.setIndex([0, 1, 2, 0, 2, 3]);
    this.aStart = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aEnd = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    base.setAttribute('aStart', this.aStart);
    base.setAttribute('aEnd', this.aEnd);
    base.setAttribute('aColor', this.aColor);
    base.instanceCount = 0;
    this.uniforms = { uFogDensity: { value: 0.0005 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aStart;
        attribute vec3 aEnd;
        attribute vec4 aColor;
        uniform float uFogDensity;
        varying vec4 vColor;
        varying vec2 vUv;
        varying float vFog;
        void main() {
          vec3 p = mix(aStart, aEnd, position.y);
          vec3 dir = aEnd - aStart;
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(dir, toCam) + vec3(1e-5, 0.0, 0.0));
          float d = distance(cameraPosition, p);
          float w = aColor.a * max(1.0, d * 0.0025);
          p += side * position.x * w;
          vUv = vec2(position.x + 0.5, position.y);
          vColor = aColor;
          vFog = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        varying vec2 vUv;
        varying float vFog;
        void main() {
          float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
          float a = across * across * smoothstep(0.0, 0.45, vUv.y) * (1.0 - vFog);
          gl_FragColor = vec4(vColor.rgb, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(base, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(1);
    this.mesh.renderOrder = 12;
  }

  begin() {
    this.n = 0;
  }

  add(sx, sy, sz, ex, ey, ez, r, g, b, width) {
    if (this.n >= this.max) return;
    const i = this.n++;
    const s = this.aStart.array;
    const e = this.aEnd.array;
    const c = this.aColor.array;
    s[i * 3] = sx;
    s[i * 3 + 1] = sy;
    s[i * 3 + 2] = sz;
    e[i * 3] = ex;
    e[i * 3 + 1] = ey;
    e[i * 3 + 2] = ez;
    c[i * 4] = r;
    c[i * 4 + 1] = g;
    c[i * 4 + 2] = b;
    c[i * 4 + 3] = width;
  }

  end() {
    const geo = this.mesh.geometry;
    geo.instanceCount = this.n;
    if (this.n) {
      this.aStart.addUpdateRange(0, this.n * 3);
      this.aEnd.addUpdateRange(0, this.n * 3);
      this.aColor.addUpdateRange(0, this.n * 4);
      this.aStart.needsUpdate = this.aEnd.needsUpdate = this.aColor.needsUpdate = true;
    }
  }
}
