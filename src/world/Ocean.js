import * as THREE from 'three';
import { WAVES, MAX_WAVES, WAVES_GLSL, wavePhases, sampleWaves } from './waves.js';
import { SHORE_GLSL } from './shaders/shore.glsl.js';
import { HAZE_GLSL } from './shaders/haze.glsl.js';
import { heightAt, shoreZ } from './Terrain.js';
import { makeFoamTexture, makeSeaDetailTexture } from '../fx/TextureFactory.js';

// The sea. One custom shader for every quality tier; features are compiled in or out with WATER_Q (0..3).
// The shading follows the water model of dgreenheck/tidewater (MIT), trimmed to what is cheap in WebGL:
//   exact dielectric Fresnel, sky reflection from the PMREM environment with Cox-Munk roughness from the
//   pixel footprint (distant water gets rougher and reflects higher, darker sky), GGX sun glint, a refracted
//   ray traced to the baked seabed with Beer-Lambert absorption and analytic in-scattering, crest
//   translucency, and foam thresholded against a lace texture. The camera never leaves the bunker, so
//   screen-space refraction/SSR are not needed: the seabed is known analytically.

const MAX_WAKES = 8;

const VERT = /* glsl */ `
  attribute float aSpacing;
  uniform mat4 uTextureMatrix;
  varying vec3 vWorld;
  varying vec2 vRest;
  varying float vHeight;
  varying vec4 vShore; // x: shore foam, y: shore slope, z: crest, w: whitecap (low tier)
  #ifdef REFLECTION
    varying vec4 vReflCoord;
  #endif
  ${WAVES_GLSL}
  ${SHORE_GLSL}
  void main() {
    vec3 p = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
    vec4 sd = bhShoreSample( p.xz );
    float depth = - sd.r;
    vec3 d = bhGerstnerDisp( p.xz, depth, aSpacing );
    float slope, foam, crest;
    float sy = bhShoreWave( sd.g, depth, p.x, slope, foam, crest );
    float lam = sqrt( 9.81 * clamp( depth, 0.25, 25.0 ) ) * uShore.x;
    sy *= 1.0 - smoothstep( 0.08, 0.2, aSpacing / lam );
    vec3 wp = p + d;
    wp.y += sy;
    vWorld = wp;
    vRest = p.xz;
    vHeight = wp.y;
    vShore = vec4( foam, slope, crest, 0.0 );
    #if WATER_Q == 0
      vec4 g = bhGerstnerGrad( p.xz, depth, aSpacing * 0.5 );
      vShore.w = clamp( ( 0.62 - g.w ) * 2.5, 0.0, 1.0 );
    #endif
    #ifdef REFLECTION
      vReflCoord = uTextureMatrix * vec4( wp, 1.0 );
    #endif
    gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
  }
`;

const FRAG = /* glsl */ `
  #define ENVMAP_TYPE_CUBE_UV
  uniform sampler2D envMap;
  uniform mat3 uEnvRot;
  uniform float uEnvIntensity;
  uniform sampler2D uNormalMap;
  uniform sampler2D uFoamMap;
  uniform sampler2D uDetailMap;
  uniform sampler2D uSandMap;
  uniform vec4 uScroll;       // two detail normal-map offsets
  uniform vec2 uDrift;        // gust drift
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;     // irradiance (colour * intensity)
  uniform vec3 uSkyRad;       // average sky radiance (irradiance / PI)
  uniform vec3 uHorizon;
  uniform vec3 uAbsorb;
  uniform vec3 uScatter;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uWhitecaps;
  uniform float uTime;
  uniform vec4 uWakes[ ${MAX_WAKES} ];
  uniform int uWakeCount;
  #ifdef REFLECTION
    uniform sampler2D uReflMap;
    varying vec4 vReflCoord;
  #endif
  varying vec3 vWorld;
  varying vec2 vRest;
  varying float vHeight;
  varying vec4 vShore;

  #include <common>
  #include <cube_uv_reflection_fragment>
  ${WAVES_GLSL}
  ${SHORE_GLSL}
  ${HAZE_GLSL}

  float fresnelDielectric( float cosI, float eta ) {
    float c = clamp( cosI, 0.0, 1.0 );
    float g2 = eta * eta - 1.0 + c * c;
    if ( g2 < 0.0 ) return 1.0;
    float g = sqrt( g2 );
    float a = ( g - c ) / ( g + c );
    float b = ( c * ( g + c ) - 1.0 ) / ( c * ( g - c ) + 1.0 );
    return 0.5 * a * a * ( b * b + 1.0 );
  }
  float ggxD( float NdH, float a2 ) {
    float d = NdH * NdH * ( a2 - 1.0 ) + 1.0;
    return a2 / ( PI * d * d );
  }
  float smithV( float NdL, float NdV, float a2 ) {
    float gv = NdL * sqrt( NdV * NdV * ( 1.0 - a2 ) + a2 );
    float gl = NdV * sqrt( NdL * NdL * ( 1.0 - a2 ) + a2 );
    return 0.5 / max( gv + gl, 1e-5 );
  }
  float phaseHG( float cosT, float g ) {
    float g2 = g * g;
    return ( 1.0 - g2 ) / ( 4.0 * PI ) / pow( max( 1.0 + g2 - 2.0 * g * cosT, 1e-4 ), 1.5 );
  }
  vec2 rot2( vec2 p, float a ) {
    float c = cos( a ), s = sin( a );
    return vec2( c * p.x - s * p.y, s * p.x + c * p.y );
  }

  // Foam from boat wakes: a Kelvin wedge (19.5 deg arms), turbulent centre line and bow wave.
  float bhWakes( vec2 xz ) {
    float f = 0.0;
    for ( int i = 0; i < ${MAX_WAKES}; i ++ ) {
      if ( i >= uWakeCount ) break;
      vec4 w = uWakes[ i ];
      vec2 fwd = vec2( sin( w.z ), cos( w.z ) );
      vec2 rel = xz - w.xy;
      float along = dot( rel, fwd );
      if ( along < -260.0 || along > 14.0 ) continue;
      float across = abs( dot( rel, vec2( fwd.y, - fwd.x ) ) );
      float spd = clamp( w.w / 8.0, 0.0, 1.0 );
      float b = - along - 7.0;
      float wake = 0.0;
      if ( b > 0.0 ) {
        float arm = across - ( b * 0.354 + 3.2 );
        wake += exp( - arm * arm / ( 2.5 + b * 0.15 ) ) * exp( - b / ( 20.0 + 30.0 * spd ) ) * 0.4;
        wake += exp( - across * across / ( 6.0 + b * 0.25 ) ) * exp( - b / ( 16.0 + 24.0 * spd ) ) * 0.9;
      }
      float bow = smoothstep( 13.0, 8.5, along ) * smoothstep( 2.0, 7.0, along );
      wake += bow * exp( - pow( across - 3.4, 2.0 ) / 1.5 ) * 0.9;
      f += wake * spd;
    }
    return f;
  }

  void main() {
    vec3 toEye = cameraPosition - vWorld;
    float dist = length( toEye );
    vec3 V = toEye / dist;
    vec2 xz = vRest;
    float footprint = max( length( fwidth( xz ) ), 1e-3 );
    vec4 sd = bhShoreSample( xz );
    float depth = - sd.r;
    vec3 L = normalize( uSunDir );

    // ---------------------------------------------------------------- surface normal
    vec2 sdir = vec2( sd.b, sqrt( max( 0.0, 1.0 - sd.b * sd.b ) ) );
    #if WATER_Q >= 1
      float sSlope, sFoam, sCrest;
      bhShoreWave( sd.g, depth, xz.x, sSlope, sFoam, sCrest );
      vec4 g = bhGerstnerGrad( xz, depth, footprint );
      float whitecap = clamp( ( 0.62 - g.w ) * 2.5, 0.0, 1.0 );
    #else
      float sSlope = vShore.y, sFoam = vShore.x, sCrest = vShore.z;
      vec4 g = bhGerstnerGrad( xz, depth, max( footprint, 1.5 ) );
      float whitecap = vShore.w;
    #endif
    vec3 N = normalize( vec3( - g.x - sSlope * sdir.x, g.z, - g.y - sSlope * sdir.y ) );

    // Wind gusts and slicks over hundreds of metres: the large-scale light/dark patchiness of a real sea.
    float gust = texture2D( uDetailMap, xz / 620.0 + uDrift ).r;
    float slick = texture2D( uDetailMap, vec2( xz.y, xz.x ) / vec2( 1100.0, 140.0 ) + uDrift * 0.3 ).g;
    gust = clamp( ( gust - 0.5 ) * 2.4 + 0.5, 0.0, 1.0 );
    float rough = mix( 0.55, 1.45, gust ) * ( 1.0 - slick * 0.7 );

    // Small ripples from the normal map, rotated so the two tiles never line up.
    float near = 1.0 - smoothstep( 0.08, 1.2, footprint );
    vec3 n1 = texture2D( uNormalMap, rot2( xz, 0.63 ) / 9.0 + uScroll.xy ).xzy * 2.0 - 1.0;
    vec2 ripple = n1.xz;
    #if WATER_Q >= 1
      vec3 n2 = texture2D( uNormalMap, rot2( xz, 2.14 ) / 23.0 + uScroll.zw ).xzy * 2.0 - 1.0;
      ripple = ripple * 0.6 + n2.xz * 0.55;
    #endif
    #if WATER_Q >= 3
      vec3 n3 = texture2D( uNormalMap, rot2( xz, -1.1 ) / 3.1 - uScroll.yx * 1.7 ).xzy * 2.0 - 1.0;
      ripple += n3.xz * 0.35 * smoothstep( 0.05, 0.01, footprint );
    #endif
    float calm = smoothstep( 0.0, 1.5, depth ); // ripples die on the sand
    N = normalize( N + vec3( ripple.x, 0.0, ripple.y ) * 0.16 * rough * near * calm );

    // ---------------------------------------------------------------- foam coverage
    float surfZone = smoothstep( 3.2, 0.9, depth ) * smoothstep( -0.3, 0.2, depth );
    float coverage = sFoam * 1.25 + whitecap * uWhitecaps * mix( 0.5, 1.5, gust ) + surfZone * 0.4;
    #if WATER_Q >= 1
      coverage += bhWakes( xz );
    #endif
    coverage = clamp( coverage, 0.0, 1.0 );
    vec2 fuv = xz * 0.09;
    vec4 p1 = texture2D( uFoamMap, fuv + uScroll.xy * 0.5 );
    #if WATER_Q >= 1
      vec4 p2 = texture2D( uFoamMap, rot2( fuv, 0.64 ) * 2.37 + vec2( 0.31, 0.77 ) - uScroll.zw * 0.3 );
      float pattern = p1.r * 0.62 + p2.r * 0.38;
    #else
      float pattern = p1.r;
    #endif
    float thresh = 1.05 - coverage * 1.1;
    float soft = 0.06 + footprint * 0.1;
    float detail = smoothstep( thresh - soft, thresh + soft, pattern ) * ( p1.g * 0.25 + 0.8 );
    float foam = mix( detail, coverage * 0.85, smoothstep( 0.15, 1.2, footprint ) );

    // ---------------------------------------------------------------- reflection (tidewater section 5)
    float NdV = max( dot( N, V ), 1e-3 );
    float F = fresnelDielectric( NdV, 1.333 );
    float mss = 0.0388; // Cox-Munk mean square slope at ~7 m/s wind
    float kpx = PI / footprint;
    float unresolved = clamp( log2( 110.0 / kpx ) / 9.0, 0.0, 1.0 );
    float roughVar = rough * rough;
    float alpha2 = 0.035 * 0.035 + mss * 2.0 * unresolved * roughVar + foam * 0.2;
    float sigmaUnres = sqrt( mss * unresolved * roughVar );
    vec3 Rraw = reflect( - V, N );
    float Rup = max( Rraw.y, 0.004 ) + sigmaUnres * 1.3 * ( 1.0 - max( Rraw.y, 0.0 ) );
    vec3 R = normalize( vec3( Rraw.x, Rup, Rraw.z ) );
    float horizonOcc = smoothstep( -0.12, 0.08, Rraw.y );
    float envRough = clamp( sqrt( sqrt( alpha2 ) ), 0.0, 1.0 );
    vec3 sky = textureCubeUV( envMap, uEnvRot * R, envRough ).rgb * uEnvIntensity;
    vec3 refl = mix( uHorizon * 0.35, sky, horizonOcc );
    #ifdef REFLECTION
      vec4 rc = vReflCoord;
      rc.xy += N.xz * 2.0 * rc.w * 0.03;
      vec4 planar = texture2DProj( uReflMap, rc );
      refl = mix( refl, planar.rgb, planar.a * ( 1.0 - smoothstep( 0.1, 0.5, envRough ) * 0.6 ) );
    #endif

    // GGX sun glint.
    vec3 H = normalize( L + V );
    float NdL = max( dot( N, L ), 0.0 );
    float spec = ggxD( max( dot( N, H ), 0.0 ), alpha2 ) * smithV( NdL, NdV, alpha2 ) * fresnelDielectric( max( dot( V, H ), 0.0 ), 1.333 ) * NdL;
    vec3 sunSpec = uSunColor * min( spec, 400.0 ) * smoothstep( -0.02, 0.05, L.y );

    // ---------------------------------------------------------------- transmission: seabed + water volume
    vec3 Tr = refract( - V, N, 1.0 / 1.333 );
    vec3 Tv = normalize( vec3( Tr.x, min( Tr.y, -0.08 ), Tr.z ) );
    float tDown = max( - Tv.y, 0.04 );
    float L0 = max( vWorld.y - sd.r, 0.0 ) / tDown;
    float Lt = L0;
    #if WATER_Q >= 1
      if ( L0 < 60.0 ) {
        float L1 = max( vWorld.y - bhShoreSample( xz + Tv.xz * min( L0, 120.0 ) ).r, 0.0 ) / tDown;
        Lt = max( vWorld.y - bhShoreSample( xz + Tv.xz * min( 0.5 * ( L0 + L1 ), 120.0 ) ).r, 0.0 ) / tDown;
      }
    #endif
    float pathLen = clamp( Lt, 0.0, 400.0 );
    vec2 bedXZ = xz + Tv.xz * min( pathLen, 60.0 );
    float bedDepth = max( - bhShoreSample( bedXZ ).r, 0.0 );
    vec3 sigA = uAbsorb + vec3( 0.1, 0.2, 0.62 ) * surfZone * 0.16;   // suspended sand in the surf
    vec3 sigS = uScatter + vec3( 0.9, 1.0, 0.85 ) * surfZone * 0.16 + foam * 0.05;
    vec3 sigT = sigA + sigS;
    vec3 Ls = - refract( - L, vec3( 0.0, 1.0, 0.0 ), 1.0 / 1.333 );
    float muS = max( Ls.y, 0.1 );
    vec3 sunIn = uSunColor * ( 1.0 - fresnelDielectric( max( L.y, 0.02 ), 1.333 ) ) * smoothstep( -0.02, 0.05, L.y );
    // Wet sand on the bottom, lit by the sun and sky through the water above it.
    vec3 sand = texture2D( uSandMap, bedXZ / 3.6 ).rgb * vec3( 0.74, 0.7, 0.66 );
    vec3 bedLight = sunIn * muS * exp( - sigT * bedDepth / muS ) * RECIPROCAL_PI + uSkyRad * exp( - sigT * bedDepth * 1.2 );
    vec3 Tview = exp( - sigT * pathLen );
    float muV = max( - Tv.y, 0.15 );
    vec3 kSun = sigT * ( 1.0 + muV / muS );
    vec3 kAmb = sigT * ( 1.0 + muV / 0.75 );
    float phase = phaseHG( dot( Tv, Ls ), 0.86 ) * 0.7 + 0.3 / ( 4.0 * PI );
    vec3 bb = sigS * 0.035;
    vec3 albedoMS = bb * 1.32 / ( sigA + bb );
    vec3 inSun = sunIn * ( sigS * phase + albedoMS * sigT * RECIPROCAL_PI ) * ( 1.0 - exp( - kSun * pathLen ) ) / kSun;
    vec3 inAmb = uSkyRad * ( sigS * 0.25 + albedoMS * sigT ) * ( 1.0 - exp( - kAmb * pathLen ) ) / kAmb;
    // Crest translucency: light through thin wave tops seen against the sun.
    vec2 vH = normalize( vec2( V.x, V.z ) + 1e-5 );
    vec2 lH = normalize( vec2( L.x, L.z ) + 1e-5 );
    float back = pow( clamp( dot( vH, - lH ) * 0.6 + 0.4, 0.0, 1.0 ), 2.5 );
    float crestK = clamp( vHeight * 1.2 + 0.1, 0.0, 1.0 ) * ( clamp( ( 1.0 - N.y ) * 4.0, 0.0, 1.0 ) + 0.25 ) + sCrest * 0.8;
    vec3 sss = uSunColor * vec3( 0.12, 0.55, 0.45 ) * 0.06 * back * crestK * smoothstep( 0.0, 0.25, L.y );
    // Scattering gain: our lights are dimmer than tidewater's physical sun, keep the same water body colour.
    vec3 transmitted = sand * bedLight * Tview + ( inSun + inAmb ) * 2.2 + sss;

    // ---------------------------------------------------------------- compose
    vec3 foamLit = ( uSunColor * ( NdL * 0.75 + 0.25 ) * RECIPROCAL_PI + uSkyRad * 0.95 ) * 0.85;
    vec3 water = mix( transmitted, refl, F ) + sunSpec;
    vec3 col = mix( water, foamLit + sunSpec * 0.05, clamp( foam, 0.0, 1.0 ) );

    // Aerial perspective, matching the fog chunks used by every other material.
    float haze = bhHazeAmount( - toEye, cameraPosition.y, uFogDensity );
    float sunM = max( max( uSunColor.r, uSunColor.g ), max( uSunColor.b, 1e-3 ) );
    vec3 hazeCol = uFogColor * ( 1.0 + uSunColor / sunM * bhSunGlow( dot( - V, L ) ) * min( 1.0, sunM / 3.0 ) );
    col = mix( col, hazeCol, haze );

    // Fade into the sand where the water film thins out.
    float thickness = vWorld.y - sd.r;
    float alpha = smoothstep( 0.0, max( fwidth( thickness ) * 1.5, 0.06 ), thickness );
    gl_FragColor = vec4( col, alpha );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Sea grid aligned with the shoreline: columns dense in front of the bunker, rows dense at the waterline and
 * following its curve, growing towards the horizon. aSpacing = local vertex spacing for band limiting.
 * Rows below `shallowRows` (the last few metres of water) are drawn blended, the rest opaque.
 */
function oceanGeometry(cols, rows) {
  const X = 3000;
  const Z = 3000;
  const kx = 0.05;
  const kz = 0.03;
  const fx = (u) => X * (kx * u + (1 - kx) * u * u * u);
  const dfx = (u) => X * (kx + 3 * (1 - kx) * u * u);
  const fz = (v) => Z * (kz * v + (1 - kz) * v * v * v);
  const dfz = (v) => Z * (kz + 3 * (1 - kz) * v * v);
  const nv = (cols + 1) * (rows + 1);
  const pos = new Float32Array(nv * 3);
  const spacing = new Float32Array(nv);
  const shore = new Float32Array(cols + 1);
  for (let i = 0; i <= cols; i++) shore[i] = shoreZ(fx(-1 + (2 * i) / cols));
  let shallowRows = 1;
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    const off = fz(v);
    if (off < 16) shallowRows = j + 1;
    for (let i = 0; i <= cols; i++) {
      const u = -1 + (2 * i) / cols;
      const o = j * (cols + 1) + i;
      pos[o * 3] = fx(u);
      pos[o * 3 + 1] = 0;
      pos[o * 3 + 2] = shore[i] + 4 - off;
      spacing[o] = Math.max(dfx(u) * (2 / cols), dfz(v) / rows);
    }
  }
  const quads = cols * rows;
  const index = new Uint32Array(quads * 6);
  let k = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      index.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSpacing', new THREE.BufferAttribute(spacing, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  const split = Math.min(rows, shallowRows) * cols * 6;
  geo.addGroup(0, split, 0);
  geo.addGroup(split, index.length - split, 1);
  geo.computeBoundingSphere();
  return geo;
}

/** Flat sea beyond the grid, sunk 1 m so wave troughs never reveal it. */
function skirtGeometry() {
  const geo = new THREE.PlaneGeometry(24000, 24000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -1, 0);
  geo.setAttribute('aSpacing', new THREE.BufferAttribute(new Float32Array(4).fill(1e4), 1));
  return geo;
}

export class Ocean {
  constructor(assets, scene, water) {
    this.assets = assets;
    this.scene = scene;
    this.time = 0;
    this.phases = new Float32Array(MAX_WAVES);
    const normals = assets.textures.waterNormals;
    normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
    const sand = assets.textures.damp_beach_sand.map;

    this.uniforms = {
      envMap: { value: null },
      uEnvRot: { value: new THREE.Matrix3() },
      uEnvIntensity: { value: 1 },
      uNormalMap: { value: normals },
      uFoamMap: { value: makeFoamTexture(256) },
      uDetailMap: { value: makeSeaDetailTexture() },
      uSandMap: { value: sand },
      uScroll: { value: new THREE.Vector4() },
      uDrift: { value: new THREE.Vector2() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSkyRad: { value: new THREE.Color(0.3, 0.4, 0.6) },
      uHorizon: { value: new THREE.Color(0.6, 0.7, 0.8) },
      uAbsorb: { value: new THREE.Vector3(0.42, 0.075, 0.035) },
      uScatter: { value: new THREE.Vector3(0.012, 0.018, 0.024) },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0.0005 },
      uWhitecaps: { value: 0.5 },
      uTime: { value: 0 },
      uWakes: { value: Array.from({ length: MAX_WAKES }, () => new THREE.Vector4()) },
      uWakeCount: { value: 0 },
      uReflMap: { value: null },
      uTextureMatrix: { value: new THREE.Matrix4() },
      uWaveA: { value: WAVES.map((w) => new THREE.Vector4(w.dirX, w.dirZ, w.k, w.A)) },
      uWaveB: { value: WAVES.map((w) => new THREE.Vector4(w.Q, w.phase, w.d0, w.floor)) },
    };
    this.mesh = null;
    this.skirt = null;
    this.reflection = null;
    this.wakeSources = [];
    this.setMode(water);
  }

  /** Shore uniforms shared with the terrain (see World). */
  attachShore(shore) {
    Object.assign(this.uniforms, shore.uniforms);
  }

  setMode(water) {
    const w = water && typeof water === 'object' ? water : { q: 1, waves: 6, grid: [320, 110], reflection: 256, wakes: 4 };
    const key = JSON.stringify(w);
    if (this.modeKey === key && this.mesh) return;
    this.modeKey = key;
    this.water = w;
    this.waveCount = Math.min(MAX_WAVES, w.waves);
    this.disposeMeshes();
    this.setReflection(w.reflection);
    this.buildMaterials();
    this.mesh = new THREE.Mesh(oceanGeometry(w.grid[0], w.grid[1]), this.mats);
    this.mesh.name = 'ocean';
    this.mesh.frustumCulled = false;
    this.skirt = new THREE.Mesh(skirtGeometry(), this.mats[1]);
    this.skirt.name = 'ocean-skirt';
    this.skirt.frustumCulled = false;
    this.mesh.onBeforeRender = (renderer, scene, camera) => this.renderReflection(renderer, scene, camera);
    this.scene.add(this.mesh, this.skirt);
  }

  buildMaterials() {
    for (const m of this.mats || []) m.dispose();
    const defines = { WATER_Q: this.water.q, WAVE_COUNT: this.waveCount };
    if (this.reflection) defines.REFLECTION = '';
    const envH = this.uniforms.envMap.value?.image?.height;
    if (envH) {
      // Same sizes three derives for PMREM textures (WebGLProgram generateCubeUVSize).
      const maxMip = Math.log2(envH) - 2;
      defines.CUBEUV_TEXEL_WIDTH = 1 / (3 * Math.max(2 ** maxMip, 7 * 16));
      defines.CUBEUV_TEXEL_HEIGHT = 1 / envH;
      defines.CUBEUV_MAX_MIP = `${maxMip}.0`;
    } else {
      defines.CUBEUV_TEXEL_WIDTH = 1 / 768;
      defines.CUBEUV_TEXEL_HEIGHT = 1 / 256;
      defines.CUBEUV_MAX_MIP = '6.0';
    }
    const make = (transparent) =>
      new THREE.ShaderMaterial({
        name: transparent ? 'ocean-shallow' : 'ocean',
        uniforms: this.uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        defines,
        transparent,
        depthWrite: true,
      });
    this.mats = [make(true), make(false)];
    this.envHeight = envH;
    if (this.mesh) {
      this.mesh.material = this.mats;
      this.skirt.material = this.mats[1];
    }
  }

  setReflection(size) {
    if (this.reflection) {
      this.reflection.target.dispose();
      this.reflection = null;
    }
    if (!size) return;
    const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType });
    this.reflection = {
      size,
      target,
      camera: new THREE.PerspectiveCamera(),
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      viewPlane: new THREE.Plane(),
      clip: new THREE.Vector4(),
      q: new THREE.Vector4(),
      view: new THREE.Vector3(),
      target3: new THREE.Vector3(),
      lookAt: new THREE.Vector3(),
      rot: new THREE.Matrix4(),
    };
    this.uniforms.uReflMap.value = target.texture;
  }

  disposeMeshes() {
    for (const m of [this.mesh, this.skirt]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.mesh = this.skirt = null;
  }

  /** Mirror-camera render of layer 0 (boats, vehicles, aircraft) for the high tiers; after three's Water.js. */
  renderReflection(renderer, scene, camera) {
    const r = this.reflection;
    // Called once per material group; render the mirror only once per frame.
    if (!r || this.inReflection || renderer.info.render.frame === this.reflFrame) return;
    const cam = r.camera;
    const normal = r.plane.normal;
    r.view.setFromMatrixPosition(camera.matrixWorld);
    if (r.view.y <= 0) return;
    r.view.y = -r.view.y;
    r.rot.extractRotation(camera.matrixWorld);
    r.lookAt.set(0, 0, -1).applyMatrix4(r.rot).add(camera.position);
    r.target3.copy(r.lookAt);
    r.target3.y = -r.target3.y;
    cam.position.copy(r.view);
    cam.up.set(0, 1, 0).applyMatrix4(r.rot).reflect(normal);
    cam.lookAt(r.target3);
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);
    const tm = this.uniforms.uTextureMatrix.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    // Oblique near plane at the water surface (Lengyel).
    const plane = r.viewPlane.copy(r.plane).applyMatrix4(cam.matrixWorldInverse);
    r.clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const p = cam.projectionMatrix.elements;
    r.q.set((Math.sign(r.clip.x) + p[8]) / p[0], (Math.sign(r.clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
    r.clip.multiplyScalar(2 / r.clip.dot(r.q));
    p[2] = r.clip.x;
    p[6] = r.clip.y;
    p[10] = r.clip.z + 1;
    p[14] = r.clip.w;

    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevBg = scene.background;
    const prevClear = renderer.getClearAlpha();
    this.inReflection = true;
    this.mesh.visible = this.skirt.visible = false;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearAlpha(0);
    renderer.setRenderTarget(r.target);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setClearAlpha(prevClear);
    renderer.shadowMap.autoUpdate = prevShadow;
    scene.background = prevBg;
    this.mesh.visible = this.skirt.visible = true;
    this.inReflection = false;
    this.reflFrame = renderer.info.render.frame;
    renderer.setRenderTarget(prevTarget);
    const vp = camera.viewport;
    if (vp !== undefined) renderer.state.viewport(vp);
  }

  /** Lighting from the time-of-day preset (see Sky.apply). */
  applySky(sky, preset) {
    const u = this.uniforms;
    u.uSunDir.value.copy(sky.sunDir).normalize();
    u.uSunColor.value.copy(sky.sun.color).multiplyScalar(sky.sun.intensity);
    u.uSkyRad.value.copy(sky.skyRad);
    u.uHorizon.value.copy(sky.horizonRad);
    u.uFogColor.value.copy(sky.fog.color);
    u.uFogDensity.value = sky.fog.density;
    u.uEnvIntensity.value = this.scene.environmentIntensity;
    u.uEnvRot.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-(sky.rotation || 0)));
    u.uWhitecaps.value = preset?.whitecaps ?? 0.5;
    const env = sky.envMap;
    if (u.envMap.value !== env) {
      u.envMap.value = env;
      if (env?.image?.height !== this.envHeight) this.buildMaterials();
    }
  }

  /** Boats whose wakes should be drawn (landing craft under way). */
  setWakes(list) {
    const max = this.water.wakes || 0;
    const u = this.uniforms;
    let n = 0;
    for (const e of list) {
      if (n >= max) break;
      if (!e.alive || !(e.wakeSpeed > 0.5)) continue;
      u.uWakes.value[n++].set(e.pos.x, e.pos.z, e.yaw, e.wakeSpeed);
    }
    u.uWakeCount.value = n;
  }

  /** Height and slopes of the sea surface at (x, z), from the same waves the shader draws. */
  sample(x, z, out = { y: 0, dx: 0, dz: 0 }) {
    const depth = -heightAt(x, z);
    return sampleWaves(x, z, this.time, Math.min(4, this.waveCount), depth, out);
  }

  update(dt) {
    this.time += dt;
    const u = this.uniforms;
    wavePhases(this.time, this.phases);
    for (let i = 0; i < MAX_WAVES; i++) u.uWaveB.value[i].y = this.phases[i];
    const t = this.time;
    const wrap = (v) => v - Math.floor(v);
    u.uScroll.value.set(wrap(t * 0.011), wrap(t * 0.006), wrap(-t * 0.004), wrap(t * 0.009));
    u.uDrift.value.set(wrap(t * 0.0009), wrap(t * 0.0045));
    u.uTime.value = t % 1000;
  }
}
