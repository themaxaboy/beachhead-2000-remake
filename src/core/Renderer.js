import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from '../config.js';

const DamageShader = {
  uniforms: {
    tDiffuse: { value: null },
    uFlash: { value: 0 },
    uLow: { value: 0 },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uFade: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uFlash, uLow, uTime, uFade;
    uniform vec2 uRes;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      float ca = 0.0009 + uFlash * 0.006;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + d * ca).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - d * ca).b;
      col *= mix(0.62, 1.0, smoothstep(0.62, 0.12, r2));
      float red = clamp(uFlash * 0.95 + uLow * 0.55, 0.0, 1.0) * smoothstep(0.04, 0.42, r2 * 1.6);
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col, vec3(0.75, 0.03, 0.01) * max(0.25, lum * 1.6), red * 0.75);
      float g = fract(sin(dot(vUv * uRes + fract(uTime) * 91.0, vec2(12.9898, 78.233))) * 43758.5453);
      col += (g - 0.5) * 0.03 * max(lum, 0.06);
      col *= 1.0 - uFade;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Renderer {
  constructor(canvas, qualityName = 'medium') {
    const r = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      preserveDrawingBuffer: false,
    });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false; // count every pass of a frame (reset in render())
    this.renderer = r;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 0.1, 9000);
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.enable(1); // layer 1 = effects that must not show up in water reflections

    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(50, 1, 0.01, 40);

    this.width = 1;
    this.height = 1;
    this.setQuality(qualityName);
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(name) {
    this.qualityName = CONFIG.quality[name] ? name : 'medium';
    this.quality = CONFIG.quality[this.qualityName];
    this.renderer.shadowMap.enabled = this.quality.shadows > 0;
    this.buildComposer();
    this.resize();
  }

  buildComposer() {
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: this.quality.msaa });
    const composer = new EffectComposer(this.renderer, rt);
    this.worldPass = new RenderPass(this.scene, this.camera);
    this.viewPass = new RenderPass(this.viewScene, this.viewCamera);
    this.viewPass.clear = false;
    this.viewPass.clearDepth = true;
    composer.addPass(this.worldPass);
    composer.addPass(this.viewPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.4, 0.9);
    this.bloomPass.enabled = this.quality.bloom;
    composer.addPass(this.bloomPass);
    this.damagePass = new ShaderPass(DamageShader);
    composer.addPass(this.damagePass);
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  get damage() {
    return this.damagePass.uniforms;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio);
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    this.damagePass.uniforms.uRes.value.set(w * pr, h * pr);
  }

  render(dt) {
    this.renderer.info.reset();
    this.damagePass.uniforms.uTime.value += dt;
    this.composer.render(dt);
  }
}
