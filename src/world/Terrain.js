import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { fbm2, smoothstep, lerp } from '../core/math.js';
import { SHORE_GLSL } from './shaders/shore.glsl.js';
import { makeFoamTexture } from '../fx/TextureFactory.js';

const WATERLINE = CONFIG.world.waterlineZ;

/** Z coordinate of the shoreline for a given x. */
export function shoreZ(x) {
  return WATERLINE + 14 * fbm2(x / 190 + 3.1, 0.7, 3);
}

/**
 * Analytic terrain height used by both rendering and gameplay. Bunker on a mound at the origin,
 * a gently sloping beach down to the sea at -Z and dunes rising inland at +Z.
 */
export function heightAt(x, z) {
  const zc = shoreZ(x);
  const d = z - zc; // > 0 on the beach
  let h;
  if (d < 0) {
    h = -7.5 * (1 - Math.exp(d / 55));
  } else {
    h = Math.min(3.2, d * 0.032) + smoothstep(0, 40, d) * 0.35 * fbm2(x / 35, z / 35, 3);
  }
  // Dunes inland and on the far flanks.
  const inland = smoothstep(-25, 90, z);
  const flank = smoothstep(260, 520, Math.abs(x)) * smoothstep(zc + 10, zc + 80, z);
  const dune = Math.max(inland, flank);
  if (dune > 0) {
    const n = fbm2(x / 120 + 11.3, z / 120 - 4.1, 4);
    const ridge = 1 - Math.abs(fbm2(x / 60, z / 60, 2));
    const duneH = 3.5 + 0.035 * Math.max(0, z) + 7 * n + 4 * ridge * ridge;
    h = lerp(h, Math.max(h, duneH), dune);
  }
  // Bunker mound.
  const r = Math.hypot(x, z);
  const mound = 1 - smoothstep(10.5, 30, r);
  if (mound > 0) h = lerp(h, CONFIG.world.moundHeight, mound * mound * (3 - 2 * mound));
  return h;
}

export function normalAt(x, z, out = new THREE.Vector3()) {
  const e = 0.75;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

export function isWater(x, z) {
  return heightAt(x, z) < 0;
}

/** Terrain grid: dense around the bunker, stretching out to the world edge. */
export function terrainGeometry(seg) {
  const S = CONFIG.world.size;
  const k = 0.07;
  const geo = new THREE.PlaneGeometry(2, 2, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const remap = (u) => S * (k * u + (1 - k) * u * u * u);
  for (let i = 0; i < pos.count; i++) {
    const x = remap(pos.getX(i));
    const z = remap(pos.getZ(i));
    pos.setXYZ(i, x, heightAt(x, z), z);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export class Terrain {
  constructor(assets, seg = 320) {
    this.seg = seg;
    const geo = terrainGeometry(seg);

    const dry = assets.textures.coast_sand_01;
    const wet = assets.textures.damp_beach_sand;
    const mat = new THREE.MeshStandardMaterial({
      map: dry.map,
      normalMap: dry.normalMap,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.96,
      metalness: 0,
      color: 0xf2e6d4,
    });
    this.uniforms = {
      wetMap: { value: wet.map },
      wetNormal: { value: wet.normalMap },
      uFoamMap: { value: makeFoamTexture(256) },
      uTime: { value: 0 },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBhWorld;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvBhWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      const normalBegin = THREE.ShaderChunk.normal_fragment_begin.replaceAll('vNormalMapUv', 'bhUv');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vBhWorld;
          uniform sampler2D wetMap;
          uniform sampler2D wetNormal;
          uniform sampler2D uFoamMap;
          uniform float uTime;
          ${SHORE_GLSL}`,
        )
        .replace(
          '#include <map_fragment>',
          `
          vec2 bhUv = vBhWorld.xz / 4.5;
          vec2 bhUv2 = vBhWorld.xz / 23.0 + 0.37;
          float bhH = vBhWorld.y;
          float bhN = texture2D(map, vBhWorld.xz / 97.0).g - 0.5;
          vec4 bhDry = mix(texture2D(map, bhUv), texture2D(map, bhUv2), 0.45);
          bhDry.rgb *= 1.0 + bhN * 0.35;
          vec4 bhWetTex = texture2D(wetMap, bhUv * 0.8);
          // Swash from the shared shore model: the water sheet running up the sand, and sand that stays
          // dark and glossy after each wave and then dries (after dgreenheck/tidewater, MIT).
          vec4 bhSw = bhH < 1.2 ? bhSwash(vBhWorld.x, bhH) : vec4(-1e3, 0.0, 0.0, 0.0);
          float bhMottle = smoothstep(0.25, 0.75, bhWetTex.g + bhN * 0.9);
          float bhDamp = smoothstep(1.5, 0.35, bhH + bhN * 0.5) * mix(0.25, 0.55, bhMottle);
          float wetK = max(max(bhSw.z, bhDamp), smoothstep(0.05, -0.15, bhH));
          float bhDryEdge = smoothstep(0.0, 0.6, bhSw.z) * smoothstep(1.0, 0.6, bhSw.z);
          wetK *= 1.0 - bhDryEdge * bhMottle * 0.5;
          vec3 bhWetCol = mix(bhDry.rgb, bhWetTex.rgb * vec3(0.8, 0.76, 0.72), 0.6) * 0.62;
          float bhWetLum = dot(bhWetCol, vec3(0.2126, 0.7152, 0.0722));
          bhWetCol = mix(vec3(bhWetLum), bhWetCol, 1.15) * vec3(0.97, 0.98, 1.0);
          vec3 bhRgb = mix(bhDry.rgb, bhWetCol, wetK);
          // Faint lines of grit left by earlier swash, anti-aliased with fwidth.
          float bhSl = (bhH + bhN * 0.03) / 0.065;
          float bhSlW = fwidth(bhSl) + 1e-4;
          float bhLine = smoothstep(bhSlW * 1.5 + 0.05, 0.0, abs(fract(bhSl) - 0.5)) * smoothstep(0.03, 0.1, bhH) * smoothstep(0.9, 0.5, bhH);
          bhRgb *= 1.0 - bhLine * 0.14 * (1.0 - bhSw.w);
          // Seabed: light absorbed by the water column (matches the ocean's colour at its thin edge).
          bhRgb *= exp(-vec3(0.42, 0.075, 0.035) * max(-bhH, 0.0) * 2.2);
          // The swash sheet: thin, slightly blue water with lace foam behind its leading edge.
          float bhSheet = bhSw.w;
          bhRgb = mix(bhRgb, bhRgb * vec3(0.78, 0.85, 0.88), bhSheet * 0.7);
          float bhFoamCov = smoothstep(0.0, 0.5, bhSw.x) * smoothstep(3.5, 0.8, bhSw.x) * mix(0.5, 1.0, bhSw.y);
          float bhLace = texture2D(uFoamMap, vBhWorld.xz * 0.21 + vec2(uTime * 0.004, 0.0)).r;
          float bhThr = 1.05 - bhFoamCov * 1.1;
          float bhFoam = smoothstep(bhThr - 0.08, bhThr + 0.08, bhLace) * bhFoamCov;
          bhRgb = mix(bhRgb, vec3(0.9, 0.92, 0.9), bhFoam * 0.9);
          // Contact darkening just ahead of the rushing water.
          bhRgb *= 1.0 - smoothstep(-0.9, -0.05, bhSw.x) * step(bhSw.x, 0.0) * bhSw.y * 0.2;
          vec4 bhCol = vec4(bhRgb, 1.0);
          diffuseColor *= bhCol;
          `,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = mix(roughness, mix(0.42, 0.16, bhSw.z), wetK);
          roughnessFactor = mix(roughnessFactor, 0.05, bhSheet * (1.0 - bhFoam));
          roughnessFactor = mix(roughnessFactor, 0.85, bhFoam);`,
        )
        .replace('#include <normal_fragment_begin>', normalBegin)
        .replace(
          '#include <normal_fragment_maps>',
          `
          vec3 mapN = mix(texture2D(normalMap, bhUv).xyz, texture2D(wetNormal, bhUv * 0.8).xyz, wetK) * 2.0 - 1.0;
          mapN.xy *= normalScale * (1.0 - wetK * 0.6) * (1.0 - bhSheet * 0.8);
          normal = normalize(tbn * mapN);
          `,
        );
    };
    mat.customProgramCacheKey = () => 'bh-terrain';

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
  }

  /** Shared shore uniforms (see ShoreField.createShore); must be attached before the first render. */
  attachShore(shore) {
    Object.assign(this.uniforms, shore.uniforms);
  }

  setSegments(seg) {
    if (!seg || seg === this.seg) return;
    this.seg = seg;
    this.mesh.geometry.dispose();
    this.mesh.geometry = terrainGeometry(seg);
  }

  update(dt) {
    this.uniforms.uTime.value += dt;
  }
}
