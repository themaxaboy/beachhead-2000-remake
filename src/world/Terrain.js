import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { fbm2, smoothstep, lerp } from '../core/math.js';

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

export class Terrain {
  constructor(assets) {
    const S = CONFIG.world.size;
    const k = 0.07;
    const seg = 320;
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
          uniform float uTime;`,
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
          vec4 bhWet = texture2D(wetMap, bhUv * 0.8) * vec4(0.74, 0.7, 0.66, 1.0);
          float wetK = 1.0 - smoothstep(0.35, 1.5, bhH + bhN * 0.8);
          vec4 bhCol = mix(bhDry, bhWet, wetK);
          bhCol.rgb *= mix(1.0, 0.45, smoothstep(0.0, -2.5, bhH));
          float foamLine = 0.18 + 0.16 * sin(uTime * 0.55 + vBhWorld.x * 0.013 + sin(vBhWorld.x * 0.05) * 0.8);
          float foam = smoothstep(0.22, 0.0, abs(bhH - foamLine)) * smoothstep(-0.2, 0.25, bhN + 0.1);
          bhCol.rgb = mix(bhCol.rgb, vec3(0.92, 0.93, 0.9), foam * 0.55);
          diffuseColor *= bhCol;
          `,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          'float roughnessFactor = roughness * mix(1.0, 0.38, wetK);',
        )
        .replace('#include <normal_fragment_begin>', normalBegin)
        .replace(
          '#include <normal_fragment_maps>',
          `
          vec3 mapN = mix(texture2D(normalMap, bhUv).xyz, texture2D(wetNormal, bhUv * 0.8).xyz, wetK) * 2.0 - 1.0;
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
          `,
        );
    };
    mat.customProgramCacheKey = () => 'bh-terrain';

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
  }

  update(dt) {
    this.uniforms.uTime.value += dt;
  }
}
