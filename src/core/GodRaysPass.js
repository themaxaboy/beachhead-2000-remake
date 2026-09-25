import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Screen-space sun shafts (GPU Gems 3, ch. 13): bright pixels around the sun are radially blurred towards it
// at quarter resolution and added back. Runs only while the sun is on or near the screen, so it costs nothing
// most of the time. Occlusion comes for free: smoke, aircraft and clouds are darker than the sky behind them.

const MASK = {
  uniforms: {
    tDiffuse: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uThreshold: { value: 2.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSun;
    uniform float uAspect, uThreshold;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
      // Only the sun and the sky right around it seed rays; anything darker in front of it casts a shaft.
      float fall = pow(max(0.0, 1.0 - length(d) / 0.28), 3.0);
      gl_FragColor = vec4(c / max(l, 1e-3) * smoothstep(uThreshold, uThreshold * 3.0, l) * fall, 1.0);
    }
  `,
};

const BLUR = {
  uniforms: {
    tDiffuse: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uStep: { value: 1 },
  },
  vertexShader: MASK.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSun;
    uniform float uStep;
    varying vec2 vUv;
    void main() {
      vec2 delta = (uSun - vUv) * (uStep / 8.0) * 0.9;
      vec2 uv = vUv;
      vec3 sum = vec3(0.0);
      float w = 1.0;
      for (int i = 0; i < 8; i++) {
        sum += texture2D(tDiffuse, uv).rgb * w;
        uv += delta;
        w *= 0.93;
      }
      gl_FragColor = vec4(sum / 5.9, 1.0);
    }
  `,
};

const COMPOSITE = {
  uniforms: {
    tRays: { value: null },
    uColor: { value: new THREE.Color() },
  },
  vertexShader: MASK.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tRays;
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() { gl_FragColor = vec4(texture2D(tRays, vUv).rgb * uColor, 1.0); }
  `,
};

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();

export class GodRaysPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(4, 4, opts);
    this.rtB = new THREE.WebGLRenderTarget(4, 4, opts);
    const mk = (s, extra = {}) =>
      new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(s.uniforms), vertexShader: s.vertexShader, fragmentShader: s.fragmentShader, depthTest: false, depthWrite: false, ...extra });
    this.mask = mk(MASK);
    this.blur = mk(BLUR);
    this.composite = mk(COMPOSITE, { blending: THREE.AdditiveBlending, transparent: true });
    this.quad = new FullScreenQuad(this.mask);
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.color = new THREE.Color(1, 1, 1);
    this.strength = 0;
  }

  setSun(dir, color, strength) {
    this.sunDir.copy(dir).normalize();
    this.color.copy(color);
    this.strength = strength;
  }

  setSize(w, h) {
    const qw = Math.max(1, Math.round(w / 4));
    const qh = Math.max(1, Math.round(h / 4));
    this.rtA.setSize(qw, qh);
    this.rtB.setSize(qw, qh);
    this.mask.uniforms.uAspect.value = w / Math.max(1, h);
  }

  render(renderer, writeBuffer, readBuffer) {
    // Where is the sun on screen, and how much does it face the camera?
    this.camera.getWorldDirection(_f);
    const facing = _f.dot(this.sunDir);
    _p.copy(this.camera.position).addScaledVector(this.sunDir, 1000).project(this.camera);
    const edge = Math.max(Math.abs(_p.x), Math.abs(_p.y));
    const k = this.strength * THREE.MathUtils.smoothstep(facing, 0.35, 0.75) * (1 - THREE.MathUtils.smoothstep(edge, 1.0, 1.6));
    if (k <= 0.002) return;
    const sun = this.mask.uniforms.uSun.value.set(_p.x * 0.5 + 0.5, _p.y * 0.5 + 0.5);
    this.blur.uniforms.uSun.value.copy(sun);

    const oldAuto = renderer.autoClear;
    renderer.autoClear = false;
    this.mask.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.mask;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);
    let src = this.rtA;
    let dst = this.rtB;
    for (const step of [1, 2.5, 6]) {
      this.blur.uniforms.tDiffuse.value = src.texture;
      this.blur.uniforms.uStep.value = step * 0.12;
      this.quad.material = this.blur;
      renderer.setRenderTarget(dst);
      this.quad.render(renderer);
      [src, dst] = [dst, src];
    }
    this.composite.uniforms.tRays.value = src.texture;
    this.composite.uniforms.uColor.value.copy(this.color).multiplyScalar(k);
    this.quad.material = this.composite;
    renderer.setRenderTarget(readBuffer);
    this.quad.render(renderer);
    renderer.autoClear = oldAuto;
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.mask.dispose();
    this.blur.dispose();
    this.composite.dispose();
    this.quad.dispose();
  }
}
