import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const assetUrl = (p) => `${import.meta.env.BASE_URL}assets/${p}`;

const TEXTURE_SETS = {
  coast_sand_01: ['diff', 'nor_gl'],
  damp_beach_sand: ['diff', 'nor_gl'],
  concrete: ['diff', 'nor_gl', 'rough'],
  green_metal_rust: ['diff', 'nor_gl', 'rough'],
  rusty_metal: ['diff', 'nor_gl', 'rough'],
};

const MODELS = ['old_military_crate', 'rock_07', 'barrel_03'];

/** Loads and caches every file the game needs. */
export class Assets {
  constructor(renderer) {
    this.renderer = renderer;
    this.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.textures = {};
    this.models = {};
    this.hdrCache = new Map();
    this.textureLoader = new THREE.TextureLoader();
    this.hdrLoader = new HDRLoader().setDataType(THREE.FloatType);
    this.gltfLoader = new GLTFLoader();
  }

  loadTexture(path, srgb) {
    return new Promise((resolve, reject) => {
      this.textureLoader.load(
        assetUrl(path),
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.anisotropy = this.maxAniso;
          if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
          resolve(tex);
        },
        undefined,
        reject,
      );
    });
  }

  async loadTextureSet(id) {
    const maps = TEXTURE_SETS[id];
    const out = {};
    await Promise.all(
      maps.map(async (m) => {
        const tex = await this.loadTexture(`textures/${id}/${id}_${m}_1k.jpg`, m === 'diff');
        if (m === 'diff') out.map = tex;
        else if (m === 'nor_gl') out.normalMap = tex;
        else if (m === 'rough') out.roughnessMap = tex;
      }),
    );
    return out;
  }

  loadHDR(file) {
    if (!this.hdrCache.has(file)) {
      this.hdrCache.set(
        file,
        new Promise((resolve, reject) => {
          this.hdrLoader.load(
            assetUrl(`hdri/${file}`),
            (tex) => {
              tex.mapping = THREE.EquirectangularReflectionMapping;
              resolve(tex);
            },
            undefined,
            reject,
          );
        }),
      );
    }
    return this.hdrCache.get(file);
  }

  loadModel(id) {
    return new Promise((resolve, reject) => {
      this.gltfLoader.load(assetUrl(`models/${id}/${id}_1k.gltf`), (g) => resolve(g.scene), undefined, reject);
    });
  }

  /** Loads everything needed before the menu; reports progress 0..1. */
  async loadCore(firstHdri, onProgress = () => {}) {
    const jobs = [];
    let done = 0;
    const track = (p) =>
      p.then((v) => {
        done++;
        onProgress(done / jobs.length);
        return v;
      });
    for (const id of Object.keys(TEXTURE_SETS)) {
      jobs.push(track(this.loadTextureSet(id).then((set) => (this.textures[id] = set))));
    }
    jobs.push(track(this.loadTexture('textures/waternormals.jpg', false).then((t) => (this.textures.waterNormals = t))));
    for (const id of MODELS) {
      jobs.push(
        track(
          this.loadModel(id)
            .then((m) => (this.models[id] = m))
            .catch((err) => console.warn('model failed', id, err)),
        ),
      );
    }
    jobs.push(track(this.loadHDR(firstHdri)));
    await Promise.all(jobs);
  }
}
