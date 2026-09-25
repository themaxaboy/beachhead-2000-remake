import * as THREE from 'three';
import { CONFIG } from '../config.js';

const analysisCache = new WeakMap();

/** Finds the sun (brightest region) and the average horizon colour of an equirectangular HDR. */
function analyzeHDR(tex) {
  if (analysisCache.has(tex)) return analysisCache.get(tex);
  const { data, width: W, height: H } = tex.image;
  let maxLum = 0;
  for (let r = 0; r < H / 2; r++) {
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 4;
      const l = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      if (l > maxLum) maxLum = l;
    }
  }
  const dir = new THREE.Vector3();
  const sunCol = new THREE.Color(0, 0, 0);
  let wsum = 0;
  const thr = maxLum * 0.6;
  const lums = [];
  const horizon = new THREE.Color(0, 0, 0);
  let hn = 0;
  // Cosine-weighted upper hemisphere (sun disc clamped): ambient light for the water volume and foam.
  const skyRad = new THREE.Color(0, 0, 0);
  let skyW = 0;
  for (let r = 0; r < H; r++) {
    const v = 1 - (r + 0.5) / H;
    const el = (v - 0.5) * Math.PI;
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 4;
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      const phi = ((c + 0.5) / W - 0.5) * Math.PI * 2;
      if (el > 0.09 && el < 1.0 && (c & 3) === 0) {
        lums.push(Math.min(48, R) * 0.2126 + Math.min(48, G) * 0.7152 + Math.min(48, B) * 0.0722);
      }
      if (el > 0 && (c & 1) === 0) {
        const w = Math.sin(el) * Math.cos(el);
        skyRad.r += Math.min(48, R) * w;
        skyRad.g += Math.min(48, G) * w;
        skyRad.b += Math.min(48, B) * w;
        skyW += w;
      }
      if (el > 0.0 && el < 0.06) {
        horizon.r += R;
        horizon.g += G;
        horizon.b += B;
        hn++;
      }
      if (r < H / 2) {
        const l = R * 0.2126 + G * 0.7152 + B * 0.0722;
        if (l >= thr) {
          const w = l;
          dir.x += Math.cos(el) * Math.cos(phi) * w;
          dir.y += Math.sin(el) * w;
          dir.z += Math.cos(el) * Math.sin(phi) * w;
          sunCol.r += R * w;
          sunCol.g += G * w;
          sunCol.b += B * w;
          wsum += w;
        }
      }
    }
  }
  dir.normalize();
  // The sun disc can exceed half-float range, which turns the PMREM blur into NaN (black materials).
  // Its light comes from the DirectionalLight anyway, so clamp it in the texture.
  const CLAMP = 48;
  for (let i = 0; i < data.length; i++) if (data[i] > CLAMP) data[i] = CLAMP;
  tex.needsUpdate = true;
  const m = Math.max(sunCol.r, sunCol.g, sunCol.b) || 1;
  sunCol.setRGB(sunCol.r / m, sunCol.g / m, sunCol.b / m);
  horizon.setRGB(horizon.r / hn, horizon.g / hn, horizon.b / hn);
  lums.sort((x, y) => x - y);
  const median = lums[lums.length >> 1] || 1;
  skyRad.multiplyScalar(1 / (skyW || 1));
  const result = { dir, sunColor: sunCol, horizon, skyRad, maxLum, median };
  analysisCache.set(tex, result);
  return result;
}

/** Time-of-day presets: HDRI sky + matching sun, fog, exposure and water colour. */
export class Sky {
  constructor(renderer, scene, assets) {
    this.renderer = renderer;
    this.scene = scene;
    this.assets = assets;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envCache = new Map();

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    sc.near = 10;
    sc.far = 900;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x9c8a6a, 0.3);
    scene.add(this.hemi);

    this.sunDir = new THREE.Vector3(0.4, 0.6, 0.3).normalize();
    this.fog = new THREE.FogExp2(0xbfc8d0, 0.0005);
    scene.fog = this.fog;
    this.name = null;
    this.preset = CONFIG.timeOfDay.day;
  }

  setShadowSize(size) {
    this.sun.castShadow = size > 0;
    if (size > 0 && this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
  }

  async apply(name) {
    const preset = CONFIG.timeOfDay[name] || CONFIG.timeOfDay.day;
    const hdr = await this.assets.loadHDR(preset.hdri);
    const a = analyzeHDR(hdr);
    this.name = name;
    this.preset = preset;

    // Rotate the sky so its sun sits at the preset bearing.
    const b = preset.sunAzimuth;
    const want = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b));
    const rot = Math.atan2(want.x, want.z) - Math.atan2(a.dir.x, a.dir.z);
    this.scene.background = hdr;
    this.scene.backgroundRotation.set(0, rot, 0);
    this.scene.environmentRotation.set(0, rot, 0);

    if (!this.envCache.has(hdr)) this.envCache.set(hdr, this.pmrem.fromEquirectangular(hdr).texture);
    this.scene.environment = this.envCache.get(hdr);
    this.envMap = this.scene.environment;
    this.rotation = rot;

    const el = preset.elevation ?? Math.max(Math.asin(THREE.MathUtils.clamp(a.dir.y, -1, 1)), preset.minElevation);
    this.sunDir.set(Math.sin(b) * Math.cos(el), Math.sin(el), -Math.cos(b) * Math.cos(el)).normalize();
    this.sun.color.copy(a.sunColor).lerp(new THREE.Color(1, 1, 1), name === 'day' ? 0.35 : 0.15);
    if (preset.sunColor) this.sun.color.setHex(preset.sunColor);
    this.sun.intensity = preset.sunIntensity;
    this.hemi.intensity = preset.hemi;
    this.hemi.color.copy(a.horizon).multiplyScalar(1 / Math.max(0.001, Math.max(a.horizon.r, a.horizon.g, a.horizon.b)));

    // HDRIs are exposure-normalised photos: scale each so its sky has the preset's brightness.
    const skyScale = (preset.skyMedian ?? a.median) / a.median;
    this.scene.backgroundIntensity = skyScale;
    this.scene.environmentIntensity = skyScale * (preset.envBoost ?? 1);
    this.fog.color.copy(a.horizon).multiplyScalar(skyScale);
    this.fog.density = preset.fogDensity;
    this.horizonColor = a.horizon.clone();
    this.horizonRad = a.horizon.clone().multiplyScalar(skyScale);
    this.skyRad = a.skyRad.clone().multiplyScalar(this.scene.environmentIntensity);
    this.renderer.toneMappingExposure = preset.exposure;
    return preset;
  }

  /** Keeps the shadow frustum centred on where the player is looking. */
  update(focus) {
    const snap = 2;
    const fx = Math.round(focus.x / snap) * snap;
    const fz = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx + this.sunDir.x * 400, this.sunDir.y * 400, fz + this.sunDir.z * 400);
  }
}
